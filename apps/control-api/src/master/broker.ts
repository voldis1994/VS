/** Unified broker interface — strategy never talks to a concrete broker directly. */
import { randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { createLoginLockState, withLoginLock } from './capitalLoginLock.js';
import { CapitalQuoteStream } from './capitalStream.js';
import { logMasterError } from './errorJournal.js';
import { stableReadJson } from './atomicIo.js';
import { estimateTradeFees } from './moneyExit.js';
import { specForEpic } from './pipeline.js';
import {
  findOpenIntentBlocker,
  findOpenSuccessUnbooked,
  logTradeIntent,
  updateTradeAck,
} from './tradeAckJournal.js';
import type { Side } from './types.js';

export type BrokerQuote = {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  epic: string;
  ts_ms: number;
  /** Live Capital dealingRules min stop distance when known */
  min_stop_distance?: number | null;
  /** MT4 EA market/latest.json Digits — for SL/OHLC rounding */
  digits?: number | null;
  /** MT4 EA Point — instrument tick size */
  point?: number | null;
};

export type BrokerPosition = {
  position_id: string;
  epic: string;
  side: Side;
  size: number;
  open_level: number;
  stop_level: number | null;
  profit_level: number | null;
  upl: number | null;
  /** Broker open time when known — preserve TIME_STOP clock on orphan adopt */
  opened_at?: string | null;
};

export type PlaceOrderInput = {
  intent_id: string;
  epic: string;
  side: Side;
  size: number;
  stop_level?: number;
  profit_level?: number;
};

export type PlaceOrderResult = {
  ok: boolean;
  order_id: string | null;
  position_id: string | null;
  fill_price: number | null;
  /** Filled size when known (may differ from requested after normalize) */
  fill_size?: number | null;
  detail: string;
  paper: boolean;
};

export type BrokerAccount = {
  equity: number;
  balance: number;
  currency: string;
  /** Free margin / available to deal when broker provides it */
  available?: number | null;
  /** MT4 IsTradeAllowed / Reader trade_allowed — undefined if unknown */
  trade_allowed?: boolean | null;
};

export type ListOpenResult = {
  ok: boolean;
  positions: BrokerPosition[];
  detail?: string;
};

/** Canonical epic family — GOLD ↔ XAUUSD must not wipe live tickets on sync. */
export function normalizeEpicKey(epic: string): string {
  const s = String(epic || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  if (s === 'GOLD' || s === 'XAU' || s === 'XAUUSD' || s.startsWith('XAU')) return 'XAUUSD';
  if (s === 'SILVER' || s === 'XAG' || s === 'XAGUSD' || s.startsWith('XAG')) return 'XAGUSD';
  return s;
}

export function epicsMatch(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  if (a === b) return true;
  return normalizeEpicKey(a) === normalizeEpicKey(b);
}

export type BrokerHistoryBars = {
  ok: boolean;
  bars: Array<{
    open: number;
    high: number;
    low: number;
    close: number;
    ts_ms?: number;
  }>;
  detail: string;
  /** EA Digits when known (MT4 market/latest.json) */
  digits?: number | null;
  /** EA Point when known */
  point?: number | null;
};

export interface MasterBroker {
  readonly name: string;
  readonly paper: boolean;
  /**
   * When false, position manager skips Reader-style partial scale-out
   * (Check- MT4 CLOSE always full-lots — partial would be unsafe).
   */
  readonly supportsPartialClose?: boolean;
  /**
   * Capital.com native trailingStop / stopDistance. MT4 EA has no native trail —
   * only OrderModify(sl,tp). When false, skip arming native_trail_armed.
   */
  readonly supportsNativeTrailingStop?: boolean;
  connect(): Promise<{ ok: boolean; detail: string }>;
  getQuote(epic: string): Promise<BrokerQuote | null>;
  getAccount(): Promise<BrokerAccount | null>;
  /** Optional OHLC structure for LIVE analysis (Capital prices API). */
  getHistoryBars?(epic: string, maxBars?: number): Promise<BrokerHistoryBars>;
  listOpenPositions(epic?: string): Promise<ListOpenResult>;
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  closePosition(
    position_id: string,
    opts?: { size?: number }
  ): Promise<{
    ok: boolean;
    detail: string;
    fill_price?: number | null;
    /** Broker confirm.profit / paper realized — prefer over recomputed pts×size */
    fill_pnl?: number | null;
    deal_reference?: string;
    remaining_size?: number | null;
  }>;
  modifyPosition?(input: {
    position_id: string;
    stop_level?: number;
    profit_level?: number;
    /** VS-System native Capital trailingStop */
    trailing_stop?: boolean;
    /** Absolute price distance for Capital stopDistance / trailingStop */
    stop_distance?: number;
  }): Promise<{ ok: boolean; detail: string; order_id?: string }>;
}

/** In-memory paper broker — real decision/risk path, simulated fills. */
export class PaperBroker implements MasterBroker {
  readonly name = 'PAPER';
  readonly paper = true;
  readonly supportsPartialClose = true;
  private positions = new Map<string, BrokerPosition>();
  private lastQuote: BrokerQuote | null = null;
  private processed = new Set<string>();
  equity = 10_000;
  balance = 10_000;

  async connect() {
    return { ok: true, detail: 'paper ready' };
  }

  setQuote(q: BrokerQuote) {
    this.lastQuote = q;
  }

  async getQuote(epic: string) {
    if (this.lastQuote && this.lastQuote.epic === epic) return this.lastQuote;
    return this.lastQuote;
  }

  async getAccount() {
    return {
      equity: this.equity,
      balance: this.balance,
      currency: 'GBP',
      trade_allowed: true,
    };
  }

  async listOpenPositions(epic?: string): Promise<ListOpenResult> {
    const all = [...this.positions.values()];
    return {
      ok: true,
      positions: epic ? all.filter((p) => epicsMatch(p.epic, epic)) : all,
    };
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    if (this.processed.has(input.intent_id)) {
      return {
        ok: false,
        order_id: null,
        position_id: null,
        fill_price: null,
        detail: 'duplicate_intent',
        paper: true,
      };
    }
    this.processed.add(input.intent_id);
    const q = this.lastQuote;
    if (!q) {
      return {
        ok: false,
        order_id: null,
        position_id: null,
        fill_price: null,
        detail: 'no_quote',
        paper: true,
      };
    }
    const fill = input.side === 'BUY' ? q.ask : q.bid;
    const position_id = `paper-${randomUUID()}`;
    this.positions.set(position_id, {
      position_id,
      epic: input.epic,
      side: input.side,
      size: input.size,
      open_level: fill,
      stop_level: input.stop_level ?? null,
      profit_level: input.profit_level ?? null,
      upl: 0,
    });
    return {
      ok: true,
      order_id: `ord-${input.intent_id}`,
      position_id,
      fill_price: fill,
      fill_size: input.size,
      detail: 'paper_fill',
      paper: true,
    };
  }

  async closePosition(position_id: string, opts?: { size?: number }) {
    const p = this.positions.get(position_id);
    if (!p) return { ok: false, detail: 'not_found' };
    const q = this.lastQuote;
    let fill_price: number | null = null;
    const closeSize =
      opts?.size != null && Number.isFinite(opts.size) && opts.size > 0
        ? Math.min(opts.size, p.size)
        : p.size;
    if (q) {
      fill_price = p.side === 'BUY' ? q.bid : q.ask;
      // Money PnL with instrument point value + round-trip model fees.
      // Do NOT return fill_pnl — that would mark from_broker and skip journal fees.
      const pv = specForEpic(p.epic).value_per_point_per_lot;
      const pts =
        p.side === 'BUY'
          ? fill_price - p.open_level
          : p.open_level - fill_price;
      const gross = pts * closeSize * pv;
      const fees = estimateTradeFees(closeSize);
      this.equity += gross - fees;
      this.balance = this.equity;
    }
    const remaining = Math.max(0, p.size - closeSize);
    if (remaining > 1e-9) {
      p.size = remaining;
      return {
        ok: true,
        detail: `paper_partial_closed rem=${remaining}`,
        fill_price,
        fill_pnl: null,
        remaining_size: remaining,
      };
    }
    this.positions.delete(position_id);
    return {
      ok: true,
      detail: 'paper_closed',
      fill_price,
      fill_pnl: null,
      remaining_size: 0,
    };
  }

  async modifyPosition(input: {
    position_id: string;
    stop_level?: number;
    profit_level?: number;
    trailing_stop?: boolean;
    stop_distance?: number;
  }) {
    const p = this.positions.get(input.position_id);
    if (!p) return { ok: false, detail: 'not_found' };
    if (input.stop_level != null) p.stop_level = input.stop_level;
    if (input.profit_level != null) p.profit_level = input.profit_level;
    // VS-System naked fallback — paper arms a protective stop from mark ± distance
    if (
      input.trailing_stop === true &&
      input.stop_distance != null &&
      Number.isFinite(input.stop_distance) &&
      input.stop_distance > 0
    ) {
      const q = this.lastQuote;
      const mark = q
        ? p.side === 'BUY'
          ? q.bid
          : q.ask
        : p.open_level;
      p.stop_level =
        p.side === 'BUY' ? mark - input.stop_distance : mark + input.stop_distance;
    }
    return { ok: true, detail: 'paper_modified', order_id: `mod-${input.position_id}` };
  }

  /**
   * Restart rehydrate — put restored MASTER opens back into the empty paper book
   * so sync does not treat them as ghosts / broker_flat.
   */
  seedOpens(
    rows: Array<{
      position_id: string;
      epic: string;
      side: Side;
      size: number;
      open_level: number;
      stop_level?: number | null;
      profit_level?: number | null;
    }>
  ) {
    for (const r of rows) {
      this.positions.set(r.position_id, {
        position_id: r.position_id,
        epic: r.epic,
        side: r.side,
        size: r.size,
        open_level: r.open_level,
        stop_level: r.stop_level ?? null,
        profit_level: r.profit_level ?? null,
        upl: null,
      });
    }
  }

  /** Restore paper equity/balance after journal recover (VS-System paper hydrate). */
  hydrateAccount(input: { equity?: number; balance?: number }) {
    if (input.equity != null && Number.isFinite(input.equity) && input.equity > 0) {
      this.equity = Number(input.equity);
    }
    if (input.balance != null && Number.isFinite(input.balance) && input.balance > 0) {
      this.balance = Number(input.balance);
    } else if (input.equity != null && Number.isFinite(input.equity) && input.equity > 0) {
      this.balance = Number(input.equity);
    }
  }

  /** Mark-to-market open positions from quote (instrument money units). */
  markToMarket() {
    const q = this.lastQuote;
    if (!q) return;
    for (const p of this.positions.values()) {
      const mid = q.mid;
      const pv = specForEpic(p.epic).value_per_point_per_lot;
      const pts = p.side === 'BUY' ? mid - p.open_level : p.open_level - mid;
      p.upl = pts * p.size * pv;
    }
  }
}

/**
 * Capital.com adapter — wraps existing capitalCom session helpers.
 * Live path requires MASTER_LIVE_ENABLED=true at the runtime gate.
 */
export class CapitalBroker implements MasterBroker {
  readonly name = 'CAPITAL';
  readonly paper = false;
  readonly supportsPartialClose = true;
  readonly supportsNativeTrailingStop = true;
  private session: any = null;
  private processed = new Set<string>();
  /** VS-System: serialize all Capital REST for this broker instance */
  private readonly loginLock = createLoginLockState();
  /** Capital streaming quotes — REST fallback when unhealthy */
  private readonly stream = new CapitalQuoteStream();
  /** Last dealingRules seen per epic from markets quote */
  private dealRulesByEpic = new Map<
    string,
    { minSize: number; maxSize: number; step: number }
  >();
  /** Live min-stop distance per epic from markets quote */
  private minStopByEpic = new Map<string, number>();

  constructor(
    rawDeps: {
      acquire: (input: any) => Promise<{ ok: boolean; session?: any; detail: string }>;
      quote: (session: any, epic: string) => Promise<any>;
      list: (session: any) => Promise<any>;
      create: (session: any, input: any) => Promise<any>;
      close: (session: any, dealId: string, size?: number) => Promise<any>;
      modify?: (
        session: any,
        input: {
          dealId: string;
          stopLevel?: number | null;
          profitLevel?: number | null;
          stopDistance?: number | null;
          trailingStop?: boolean;
        }
      ) => Promise<{ ok: boolean; detail: string; deal_reference?: string }>;
      confirm?: (
        session: any,
        ref: string
      ) => Promise<{
        ok: boolean;
        deal_id?: string;
        fill_level?: number;
        profit?: number;
        detail: string;
        rejected?: boolean;
        pending?: boolean;
        reject_reason?: string;
      }>;
      account?: (
        session: any
      ) => Promise<{
        equity: number;
        balance: number;
        currency: string;
        available?: number | null;
      } | null>;
      /** Pin CFD account before mutate (VS-System ensureActiveAccount) */
      ensureAccount?: (session: any) => Promise<{ ok: boolean; detail: string }>;
      /** Capital minute/hour OHLC for LIVE structure seeding */
      prices?: (
        session: any,
        epic: string,
        resolution: 'MINUTE' | 'HOUR',
        max: number
      ) => Promise<{
        ok: boolean;
        candles: Array<{
          open: number;
          high: number;
          low: number;
          close: number;
          snapshotTime?: string;
        }>;
        detail: string;
      }>;
      credentials: any;
    }
  ) {
    // VS-System withLoginLock: every Capital REST dep serializes; nested
    // place→confirm→list reenters via AsyncLocalStorage.
    const lock = this.loginLock;
    this.deps = {
      credentials: rawDeps.credentials,
      acquire: (input) => withLoginLock(lock, () => rawDeps.acquire(input)),
      quote: (s, e) => withLoginLock(lock, () => rawDeps.quote(s, e)),
      list: (s) => withLoginLock(lock, () => rawDeps.list(s)),
      create: (s, i) => withLoginLock(lock, () => rawDeps.create(s, i)),
      close: (s, d, sz) => withLoginLock(lock, () => rawDeps.close(s, d, sz)),
      modify: rawDeps.modify
        ? (s, i) => withLoginLock(lock, () => rawDeps.modify!(s, i))
        : undefined,
      confirm: rawDeps.confirm
        ? (s, r) => withLoginLock(lock, () => rawDeps.confirm!(s, r))
        : undefined,
      account: rawDeps.account
        ? (s) => withLoginLock(lock, () => rawDeps.account!(s))
        : undefined,
      ensureAccount: rawDeps.ensureAccount
        ? (s) => withLoginLock(lock, () => rawDeps.ensureAccount!(s))
        : undefined,
      prices: rawDeps.prices
        ? (s, e, r, m) => withLoginLock(lock, () => rawDeps.prices!(s, e, r, m))
        : undefined,
    };
  }

  private readonly deps: {
    acquire: (input: any) => Promise<{ ok: boolean; session?: any; detail: string }>;
    quote: (session: any, epic: string) => Promise<any>;
    list: (session: any) => Promise<any>;
    create: (session: any, input: any) => Promise<any>;
    close: (session: any, dealId: string, size?: number) => Promise<any>;
    modify?: (
      session: any,
      input: {
        dealId: string;
        stopLevel?: number | null;
        profitLevel?: number | null;
        stopDistance?: number | null;
        trailingStop?: boolean;
      }
    ) => Promise<{ ok: boolean; detail: string; deal_reference?: string }>;
    confirm?: (
      session: any,
      ref: string
    ) => Promise<{
      ok: boolean;
      deal_id?: string;
      fill_level?: number;
      profit?: number;
      detail: string;
      rejected?: boolean;
      pending?: boolean;
      reject_reason?: string;
    }>;
    account?: (
      session: any
    ) => Promise<{
      equity: number;
      balance: number;
      currency: string;
      available?: number | null;
    } | null>;
    ensureAccount?: (session: any) => Promise<{ ok: boolean; detail: string }>;
    prices?: (
      session: any,
      epic: string,
      resolution: 'MINUTE' | 'HOUR',
      max: number
    ) => Promise<{
      ok: boolean;
      candles: Array<{
        open: number;
        high: number;
        low: number;
        close: number;
        snapshotTime?: string;
      }>;
      detail: string;
    }>;
    credentials: any;
  };

  /** VS-System: pin correct Capital account before create/modify/close/list. */
  private async ensureActiveAccount(): Promise<{ ok: boolean; detail: string }> {
    if (!this.session) return { ok: false, detail: 'not_connected' };
    if (!this.deps.ensureAccount) return { ok: true, detail: 'no_pin' };
    return this.deps.ensureAccount(this.session);
  }

  async connect() {
    const opened = await this.deps.acquire(this.deps.credentials);
    if (!opened.ok || !opened.session) return { ok: false, detail: opened.detail };
    this.session = opened.session;
    // Wire streaming tokens (CST/security) — REST remains fallback
    if (opened.session.cst && opened.session.securityToken && opened.session.base) {
      this.stream.setTokens({
        cst: String(opened.session.cst),
        securityToken: String(opened.session.securityToken),
        baseUrl: String(opened.session.base),
      });
    }
    return { ok: true, detail: 'capital connected' };
  }

  /** VS-System: true when WS is open and a quote arrived recently. */
  isMarketStreamHealthy(maxAgeMs = 30_000): boolean {
    return this.stream.isHealthy(maxAgeMs);
  }

  /** Subscribe epics on Capital streaming WS (best-effort). */
  async ensureMarketStream(epics: string[]): Promise<'streaming' | 'fallback'> {
    return this.stream.ensure(epics);
  }

  stopMarketStream() {
    this.stream.stop();
  }

  async getHistoryBars(epic: string, maxBars = 60): Promise<BrokerHistoryBars> {
    if (!this.session || !this.deps.prices) {
      return { ok: false, bars: [], detail: 'capital_prices_unavailable' };
    }
    const res = await this.deps.prices(this.session, epic, 'MINUTE', maxBars);
    if (!res.ok || !res.candles.length) {
      return { ok: false, bars: [], detail: res.detail || 'capital_no_candles' };
    }
    const bars = res.candles
      .map((c) => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        ts_ms: c.snapshotTime ? Date.parse(c.snapshotTime) : undefined,
      }))
      .filter((b) => [b.open, b.high, b.low, b.close].every((n) => Number.isFinite(n) && n > 0));
    return {
      ok: bars.length >= 10,
      bars,
      detail: bars.length >= 10 ? `capital_minute_${bars.length}` : `capital_minute_short_${bars.length}`,
    };
  }

  async getQuote(epic: string): Promise<BrokerQuote | null> {
    // Prefer fresh streaming mark when healthy (VS-System ensureMarketStream)
    void this.stream.ensure([epic]);
    const streamed = this.stream.getLatest(epic);
    if (streamed && this.stream.isHealthy()) {
      return {
        bid: streamed.bid,
        ask: streamed.offer,
        mid: streamed.mid,
        spread: streamed.offer - streamed.bid,
        epic: streamed.epic || epic,
        ts_ms: streamed.ts_ms,
        min_stop_distance: this.liveMinStopDistance(epic),
      };
    }

    if (!this.session) return null;
    const q = await this.deps.quote(this.session, epic);
    if (q.bid == null || q.ask == null || q.mid == null) return null;
    if (
      q.min_deal_size != null &&
      Number.isFinite(q.min_deal_size) &&
      q.min_deal_size > 0
    ) {
      const { sanitizeCapitalDealRules } = await import('./capitalSize.js');
      const key = String(q.epic || epic).toUpperCase();
      this.dealRulesByEpic.set(
        key,
        sanitizeCapitalDealRules(key, {
          minSize: Number(q.min_deal_size),
          maxSize:
            q.max_deal_size != null && Number(q.max_deal_size) > 0
              ? Number(q.max_deal_size)
              : 500,
          step:
            q.deal_size_step != null && Number(q.deal_size_step) > 0
              ? Number(q.deal_size_step)
              : Number(q.min_deal_size),
        })
      );
    }
    const minStop =
      q.min_stop_distance != null && Number.isFinite(Number(q.min_stop_distance))
        ? Number(q.min_stop_distance)
        : null;
    if (minStop != null && minStop > 0) {
      this.minStopByEpic.set(String(q.epic || epic).toUpperCase(), minStop);
    }
    return {
      bid: q.bid,
      ask: q.ask,
      mid: q.mid,
      spread: q.ask - q.bid,
      epic: q.epic || epic,
      ts_ms: Date.now(),
      min_stop_distance: minStop,
    };
  }

  /** Cached live min-stop for epic (from last quote), if known. */
  liveMinStopDistance(epic: string): number | null {
    const v = this.minStopByEpic.get(String(epic || '').toUpperCase());
    return v != null && v > 0 ? v : null;
  }

  async getAccount(): Promise<BrokerAccount | null> {
    if (!this.session) return null;
    if (this.deps.account) {
      const a = await this.deps.account(this.session);
      if (a) return a;
    }
    return { equity: 0, balance: 0, currency: 'GBP' };
  }

  async listOpenPositions(epic?: string): Promise<ListOpenResult> {
    if (!this.session) {
      return { ok: false, positions: [], detail: 'not_connected' };
    }
    const pinned = await this.ensureActiveAccount();
    if (!pinned.ok) {
      return { ok: false, positions: [], detail: `account_pin:${pinned.detail}` };
    }
    const listed = await this.deps.list(this.session);
    if (!listed.ok) {
      return {
        ok: false,
        positions: [],
        detail: (listed as { detail?: string }).detail || 'list_failed',
      };
    }
    const positions = (listed.positions as any[])
      .filter((p) => !epic || epicsMatch(p.epic, epic))
      .map((p) => {
        const openRaw = Number(p.open_level);
        const open_level =
          Number.isFinite(openRaw) && openRaw > 0 ? openRaw : null;
        return {
          position_id: p.deal_id,
          epic: p.epic,
          side: p.direction as Side,
          size: p.size,
          // Never invent 0 — orphan adopt must see missing entry as null/NaN skip
          open_level: open_level ?? Number.NaN,
          stop_level: protectiveLevelOrNull(p.stop_level),
          profit_level: protectiveLevelOrNull(p.profit_level),
          upl: p.upl ?? null,
          opened_at: p.opened_at ?? null,
        };
      })
      // Drop rows without a usable entry — safer than adopting entry=0
      .filter((p) => Number.isFinite(p.open_level) && p.open_level > 0);
    return { ok: true, positions };
  }

  private async waitConfirm(
    dealReference: string,
    opts?: { /** When true, journal ACK_TIMEOUT (OPEN only — not CLOSE/MODIFY). */ ackTimeoutAlert?: boolean }
  ): Promise<{
    ok: boolean;
    deal_id?: string;
    fill_level?: number;
    profit?: number;
    detail: string;
    rejected?: boolean;
    reject_reason?: string;
  }> {
    if (!this.deps.confirm) {
      return { ok: false, detail: 'no_confirm_dep' };
    }
    const { CAPITAL_CONFIRM_POLL_MS } = await import('./capitalConfirm.js');
    for (const delay of CAPITAL_CONFIRM_POLL_MS) {
      await new Promise((r) => setTimeout(r, delay));
      const conf = await this.deps.confirm(this.session, dealReference);
      if (conf.rejected) {
        return {
          ok: false,
          rejected: true,
          detail: conf.detail,
          fill_level: conf.fill_level,
          profit: conf.profit,
          reject_reason: conf.reject_reason,
        };
      }
      if (conf.ok && conf.deal_id) {
        return {
          ok: true,
          deal_id: conf.deal_id,
          fill_level: conf.fill_level,
          profit: conf.profit,
          detail: conf.detail,
        };
      }
      if (!conf.pending) {
        // Non-pending failure — keep polling briefly in case of lag
        continue;
      }
    }
    // Only OPEN confirm timeouts should trip cycle-alert entry blocks
    if (opts?.ackTimeoutAlert) {
      logMasterError({
        module: 'capital.waitConfirm',
        error_type: 'ACK_TIMEOUT',
        message: `confirm_timeout ref=${dealReference}`,
      });
    }
    return { ok: false, detail: `confirm_timeout ref=${dealReference}` };
  }

  /**
   * VS-System findRecentOpenPosition — near-exact size + recent opened_at.
   * Used for empty-REJECTED match-accept and unconfirmed open recovery.
   */
  private async findRecentOpenMatch(input: {
    epic: string;
    side: Side;
    size: number;
  }): Promise<BrokerPosition | undefined> {
    const tol = Math.max(input.size * 0.001, 1e-8);
    const maxAgeMs = 60_000;
    const now = Date.now();
    const attempts =
      process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true' ? 2 : 4;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) =>
          setTimeout(r, process.env.VITEST ? 5 * attempt : 250 * attempt)
        );
      }
      const listed = await this.listOpenPositions(input.epic);
      if (!listed.ok) continue;
      const candidates = listed.positions
        .filter((p) => {
          if (p.side !== input.side) return false;
          if (Math.abs(p.size - input.size) > tol) return false;
          if (p.opened_at) {
            const opened = Date.parse(p.opened_at);
            if (Number.isFinite(opened) && now - opened > maxAgeMs) return false;
          }
          return true;
        })
        .sort((a, b) => {
          const ta = a.opened_at ? Date.parse(a.opened_at) : 0;
          const tb = b.opened_at ? Date.parse(b.opened_at) : 0;
          return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
        });
      if (candidates[0]) return candidates[0];
    }
    return undefined;
  }

  /**
   * Fail-close with confirm + list-flat proof (never raw DELETE alone).
   * If the deal is still open after close, detail includes capital_fail_close_unproven.
   */
  private async failCloseOpenResult(
    position_id: string,
    order_id: string | null,
    reason: string
  ): Promise<PlaceOrderResult> {
    const closed = await this.closePosition(position_id);
    let detail = reason;
    if (!closed.ok) {
      const listed = await this.listOpenPositions();
      const still =
        listed.ok &&
        listed.positions.some((p) => p.position_id === position_id);
      detail = still
        ? `${reason}:capital_fail_close_unproven:${closed.detail}`
        : `${reason}:close=${closed.detail}`;
    }
    return {
      ok: false,
      order_id,
      position_id: null,
      fill_price: null,
      fill_size: null,
      detail,
      paper: false,
    };
  }

  /**
   * Open with stopLevel; on min-distance/ATTACHED reject open bare then attach via modify
   * (VS-System- pattern). Never treat dealReference alone as a fill.
   */
  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    if (!this.session) {
      return {
        ok: false,
        order_id: null,
        position_id: null,
        fill_price: null,
        detail: 'not_connected',
        paper: false,
      };
    }
    const pinned = await this.ensureActiveAccount();
    if (!pinned.ok) {
      return {
        ok: false,
        order_id: null,
        position_id: null,
        fill_price: null,
        detail: `account_pin:${pinned.detail}`,
        paper: false,
      };
    }
    if (this.processed.has(input.intent_id)) {
      return {
        ok: false,
        order_id: null,
        position_id: null,
        fill_price: null,
        detail: 'duplicate_intent',
        paper: false,
      };
    }
    this.processed.add(input.intent_id);

    const { isCapitalStopLevelReject } = await import('./capitalConfirm.js');
    const {
      normalizeSizeForEpic,
      normalizeCapitalDealSize,
      clampSizeForBuyingPower,
      isCapitalSizeError,
    } = await import('./capitalSize.js');
    const epicKey = String(input.epic || '').toUpperCase();
    const liveRules = this.dealRulesByEpic.get(epicKey);
    let sized = liveRules
      ? {
          ...normalizeCapitalDealSize(input.size, liveRules),
          rules: liveRules,
        }
      : normalizeSizeForEpic(input.epic, input.size);
    // Pre-send buying-power clamp (VS-System- micro-lot) — avoid RISK_CHECK when possible
    try {
      const acct = await this.getAccount();
      if (acct && acct.equity > 0) {
        const clamped = clampSizeForBuyingPower({
          epic: input.epic,
          size: sized.size,
          equity: acct.equity,
          available_to_deal: acct.available,
          rules: sized.rules,
        });
        if (clamped.adjusted) {
          sized = { ...sized, size: clamped.size, adjusted: true, reason: clamped.reason };
        }
      }
    } catch {
      /* sizing continues with step normalize only */
    }
    let orderSize = sized.size;

    let opened = await this.deps.create(this.session, {
      epic: input.epic,
      direction: input.side,
      size: orderSize,
      stopLevel: input.stop_level,
      profitLevel: input.profit_level,
    });

    // Size reject → retry once at epic min
    if (!opened.ok && isCapitalSizeError(String(opened.detail || ''))) {
      const minRaw = sized.rules.minSize;
      const minSized = liveRules
        ? normalizeCapitalDealSize(minRaw, liveRules)
        : normalizeSizeForEpic(input.epic, minRaw);
      orderSize = minSized.size;
      opened = await this.deps.create(this.session, {
        epic: input.epic,
        direction: input.side,
        size: orderSize,
        stopLevel: input.stop_level,
        profitLevel: input.profit_level,
      });
      if (!opened.ok) {
        return {
          ok: false,
          order_id: null,
          position_id: null,
          fill_price: null,
          detail: `CAPITAL_SIZE_INVALID:${opened.detail}`,
          paper: false,
        };
      }
    }

    // SL rejected at create → open bare, attach after fill
    let needAttach = false;
    if (!opened.ok && input.stop_level != null && isCapitalStopLevelReject(String(opened.detail || ''))) {
      needAttach = true;
      opened = await this.deps.create(this.session, {
        epic: input.epic,
        direction: input.side,
        size: orderSize,
        profitLevel: input.profit_level,
      });
    }

    if (!opened.ok) {
      return {
        ok: false,
        order_id: null,
        position_id: null,
        fill_price: null,
        detail: opened.detail,
        paper: false,
      };
    }

    let position_id: string | null = null;
    let fill_price: number | null = null;
    let fill_size: number | null = null;
    if (opened.deal_reference) {
      const conf = await this.waitConfirm(opened.deal_reference, {
        ackTimeoutAlert: true,
      });
      if (conf.rejected) {
        // Empty REJECTED (no named reason) often = sibling session / pin glitch with a
        // real fill already open — match-accept; NEVER blind re-POST.
        // Named rejects (RISK_CHECK / min-stop / …) still fail-close ghosts.
        const { isCapitalStopLevelReject } = await import('./capitalConfirm.js');
        const { isCapitalRiskCheckError } = await import('./capitalSize.js');
        const reasonBlob = `${conf.reject_reason || ''} ${conf.detail || ''}`;
        const namedReject =
          isCapitalRiskCheckError(reasonBlob) ||
          isCapitalStopLevelReject(reasonBlob) ||
          (conf.reject_reason != null &&
            String(conf.reject_reason).trim().length > 0 &&
            String(conf.reject_reason).toUpperCase() !== 'REJECTED');
        const emptyReject = !namedReject;
        if (emptyReject) {
          await this.ensureActiveAccount();
          await new Promise((r) =>
            setTimeout(r, process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true' ? 5 : 400)
          );
          const match = await this.findRecentOpenMatch({
            epic: input.epic,
            side: input.side,
            size: orderSize,
          });
          if (match) {
            position_id = match.position_id;
            fill_price = match.open_level || null;
            fill_size = match.size;
          }
        }
        if (!position_id) {
          // Named reject — fail-close any same-side fill that landed (ghost)
          const listed = await this.listOpenPositions(input.epic);
          const ghost = listed.positions.find(
            (p) =>
              p.side === input.side &&
              (Math.abs(p.size - orderSize) < 1e-6 || Math.abs(p.size - input.size) < 1e-6)
          );
          if (ghost) {
            return await this.failCloseOpenResult(
              ghost.position_id,
              opened.deal_reference || null,
              `capital_rejected_fail_closed:${conf.detail}`
            );
          }
          return {
            ok: false,
            order_id: opened.deal_reference || null,
            position_id: null,
            fill_price: null,
            detail: conf.detail,
            paper: false,
          };
        }
      } else if (conf.ok && conf.deal_id) {
        position_id = conf.deal_id;
        fill_price = conf.fill_level ?? null;
      }
    }

    if (!position_id) {
      const hit = await this.findRecentOpenMatch({
        epic: input.epic,
        side: input.side,
        size: orderSize,
      });
      if (hit) {
        position_id = hit.position_id;
        fill_price = hit.open_level || null;
        fill_size = hit.size;
      }
    }

    // Never accept dealReference alone as a live fill — fail-close same-size ghost if present
    if (!position_id) {
      const listed = await this.listOpenPositions(input.epic);
      const ghost = listed.positions.find(
        (p) => p.side === input.side && Math.abs(p.size - orderSize) < 1e-6
      );
      if (ghost) {
        const fail = await this.failCloseOpenResult(
          ghost.position_id,
          opened.deal_reference || null,
          `capital_unconfirmed_fail_closed:${opened.detail}`
        );
        logMasterError({
          module: 'capital.placeOrder',
          error_type: 'ACK_TIMEOUT',
          message: fail.detail,
        });
        return fail;
      }
      const detail = `capital_unconfirmed:${opened.detail}`;
      logMasterError({
        module: 'capital.placeOrder',
        error_type: 'ACK_TIMEOUT',
        message: detail,
      });
      return {
        ok: false,
        order_id: opened.deal_reference || null,
        position_id: null,
        fill_price: null,
        fill_size: null,
        detail,
        paper: false,
      };
    }

    // Attach / verify protective SL after ANY accepted fill (bare open OR empty-REJECTED match).
    // Wanted SL + missing chart stop ⇒ attach via modifyPosition (confirm + list proof);
    // fail-close if still naked — never leave LIVE unprotected.
    const wantProtectiveSl = input.stop_level != null && Number.isFinite(input.stop_level);
    if (wantProtectiveSl && position_id) {
      const listed0 = await this.listOpenPositions(input.epic);
      const cur0 = listed0.ok
        ? listed0.positions.find((p) => p.position_id === position_id)
        : undefined;
      const wantSlNum = Number(input.stop_level);
      const slTol = Math.max(0.05, Math.abs(wantSlNum) * 1e-5);
      const alreadyProtected =
        cur0?.stop_level != null &&
        Number.isFinite(cur0.stop_level) &&
        Math.abs(Number(cur0.stop_level) - wantSlNum) <= slTol;
      const wantTp =
        input.profit_level != null &&
        Number.isFinite(input.profit_level) &&
        Number(input.profit_level) > 0
          ? Number(input.profit_level)
          : null;
      const tpMissing =
        wantTp != null &&
        (cur0?.profit_level == null ||
          !Number.isFinite(cur0.profit_level) ||
          Math.abs(Number(cur0.profit_level) - wantTp) >
            Math.max(0.05, Math.abs(wantTp) * 1e-5));
      if (!alreadyProtected || tpMissing) {
        needAttach = true;
        const wantSl = wantSlNum;
        let attached = false;
        for (let widen = 0; widen < 4 && !attached; widen++) {
          const mid = fill_price ?? wantSl;
          const pad = widen * Math.max(0.5, Math.abs(mid) * 0.0005);
          const sl = input.side === 'BUY' ? wantSl - pad : wantSl + pad;
          // Always drive toward intended SL — do not preserve a soft/wrong leftover stop
          const mod = await this.modifyPosition({
            position_id,
            stop_level: alreadyProtected && !tpMissing ? cur0!.stop_level! : sl,
            profit_level: wantTp ?? input.profit_level,
          });
          if (mod.ok) {
            attached = true;
            break;
          }
          if (!isCapitalStopLevelReject(mod.detail || '')) break;
        }
        if (!attached) {
          return await this.failCloseOpenResult(
            position_id,
            opened.deal_reference || null,
            tpMissing && alreadyProtected
              ? 'CAPITAL_TP_ATTACH_FAILED'
              : 'CAPITAL_SL_ATTACH_FAILED'
          );
        }
      }
    } else if (needAttach && position_id) {
      // Bare-open path without stop_level in input — still fail-close naked
      return await this.failCloseOpenResult(
        position_id,
        opened.deal_reference || null,
        'CAPITAL_SL_ATTACH_FAILED'
      );
    }

    const listedFinal = await this.listOpenPositions(input.epic);
    const filled = listedFinal.positions.find((p) => p.position_id === position_id);
    return {
      ok: true,
      order_id: opened.deal_reference || null,
      position_id,
      fill_price,
      fill_size: fill_size ?? filled?.size ?? orderSize,
      detail: `capital_open deal=${position_id}${fill_price != null ? ` fill=${fill_price}` : ''}`,
      paper: false,
    };
  }

  async closePosition(position_id: string, opts?: { size?: number }) {
    if (!this.session) return { ok: false, detail: 'not_connected' };
    const pinned = await this.ensureActiveAccount();
    if (!pinned.ok) return { ok: false, detail: `account_pin:${pinned.detail}` };

    const partial =
      opts?.size != null && Number.isFinite(opts.size) && opts.size > 0;
    // Snapshot size before close so partials can prove reduction
    let beforeSize: number | null = null;
    {
      const beforeList = await this.listOpenPositions();
      const before = beforeList.ok
        ? beforeList.positions.find((p) => p.position_id === position_id)
        : undefined;
      if (before && Number.isFinite(before.size) && before.size > 0) {
        beforeSize = Number(before.size);
      }
    }
    // Never DELETE a partial without proven before-size (MT4 already refuses).
    // Otherwise list flakiness lets us fire close and invent reduction proof.
    if (partial && beforeSize == null) {
      return { ok: false, detail: 'capital_partial_no_before_size' };
    }

    const res = await this.deps.close(this.session, position_id, opts?.size);
    if (!res.ok) return { ok: false, detail: res.detail || 'close_failed' };

    let fill_price: number | null = null;
    let fill_pnl: number | null = null;
    const deal_reference = res.deal_reference || undefined;
    if (deal_reference && this.deps.confirm) {
      const conf = await this.waitConfirm(deal_reference);
      if (conf.rejected) {
        return {
          ok: false,
          detail: `close_confirm_rejected:${conf.detail}`,
          deal_reference,
          fill_price: conf.fill_level ?? null,
          fill_pnl: conf.profit ?? null,
        };
      }
      if (conf.fill_level != null && Number.isFinite(conf.fill_level)) {
        fill_price = conf.fill_level;
      }
      if (conf.profit != null && Number.isFinite(conf.profit)) {
        fill_pnl = Number(conf.profit);
      }
    }

    const listed = await this.listOpenPositions();
    const still = listed.ok
      ? listed.positions.find((p) => p.position_id === position_id)
      : undefined;
    if (!partial) {
      // VS-System: confirm timeout / unread book must not be treated as closed
      if (!listed.ok) {
        return {
          ok: false,
          detail: `close_unconfirmed_list_failed:${listed.detail || 'list_failed'}`,
          deal_reference,
          fill_price,
          fill_pnl,
        };
      }
      if (still) {
        return {
          ok: false,
          detail: 'close_not_confirmed_still_open',
          deal_reference,
          fill_price,
          fill_pnl,
        };
      }
    } else {
      // Partial: require list proof of size reduction (or flat)
      if (!listed.ok) {
        return {
          ok: false,
          detail: `close_partial_unconfirmed_list_failed:${listed.detail || 'list_failed'}`,
          deal_reference,
          fill_price,
          fill_pnl,
        };
      }
      if (still) {
        const reduced =
          beforeSize != null &&
          Number.isFinite(still.size) &&
          still.size < beforeSize - 1e-9;
        if (!reduced) {
          return {
            ok: false,
            detail: 'close_partial_not_confirmed_size_unchanged',
            deal_reference,
            fill_price,
            fill_pnl,
            remaining_size: still.size,
          };
        }
      }
    }

    return {
      ok: true,
      detail: deal_reference
        ? `capital_closed deal=${position_id} ref=${deal_reference}${
            fill_price != null ? ` fill=${fill_price}` : ''
          }${fill_pnl != null ? ` pnl=${fill_pnl}` : ''}${
            partial ? ` partial=${opts!.size}` : ''
          }`
        : `capital_closed deal=${position_id}`,
      fill_price,
      fill_pnl,
      deal_reference,
      remaining_size: still?.size ?? (partial ? null : 0),
    };
  }

  async modifyPosition(input: {
    position_id: string;
    stop_level?: number;
    profit_level?: number;
    trailing_stop?: boolean;
    stop_distance?: number;
  }) {
    if (!this.session) return { ok: false, detail: 'not_connected' };
    if (!this.deps.modify) return { ok: false, detail: 'modify_not_wired' };
    const pinned = await this.ensureActiveAccount();
    if (!pinned.ok) return { ok: false, detail: `account_pin:${pinned.detail}` };

    const wantSl = input.stop_level;
    const wantTp = input.profit_level;
    const trailDist = input.stop_distance;
    const hasLevel = wantSl != null && Number.isFinite(wantSl);
    const hasTp =
      wantTp != null && Number.isFinite(wantTp) && Number(wantTp) > 0;
    const hasDist =
      trailDist != null && Number.isFinite(trailDist) && Number(trailDist) > 0;
    const needsSlProof = hasLevel || hasDist || input.trailing_stop === true;
    const needsTpProof = hasTp;

    // Snapshot SL/TP before PUT — VS-System detects ACK-but-unchanged
    let beforeSl: number | null = null;
    let beforeTp: number | null = null;
    {
      const beforeList = await this.listOpenPositions();
      const before = beforeList.ok
        ? beforeList.positions.find((p) => p.position_id === input.position_id)
        : undefined;
      if (before?.stop_level != null && Number.isFinite(before.stop_level)) {
        beforeSl = Number(before.stop_level);
      }
      if (before?.profit_level != null && Number.isFinite(before.profit_level)) {
        beforeTp = Number(before.profit_level);
      }
    }

    const res = await this.deps.modify(this.session, {
      dealId: input.position_id,
      stopLevel: input.stop_level,
      profitLevel: input.profit_level,
      stopDistance: input.stop_distance,
      trailingStop: input.trailing_stop === true,
    });
    if (!res.ok) {
      return { ok: false, detail: res.detail || 'modify_failed', order_id: res.deal_reference };
    }
    if (res.deal_reference) {
      const conf = await this.waitConfirm(res.deal_reference);
      if (conf.rejected) {
        return {
          ok: false,
          detail: `modify_confirm_rejected:${conf.detail}`,
          order_id: res.deal_reference,
        };
      }
    }

    if (!needsSlProof && !needsTpProof) {
      return { ok: true, detail: res.detail || '', order_id: res.deal_reference };
    }

    const tolAbs =
      hasLevel && wantSl != null
        ? Math.max(0.05, Math.abs(wantSl) * 1e-5)
        : 0.05;
    const tpTol =
      hasTp && wantTp != null
        ? Math.max(0.05, Math.abs(Number(wantTp)) * 1e-5)
        : 0.05;
    const attempts =
      process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true' ? 3 : 5;
    let gotSl: number | null = null;
    let gotTp: number | null = null;
    let hitEpic: string | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) =>
          setTimeout(
            r,
            process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true'
              ? 5 + 5 * attempt
              : 120 + 80 * attempt
          )
        );
      }
      const listed = await this.listOpenPositions();
      const hit = listed.ok
        ? listed.positions.find((p) => p.position_id === input.position_id)
        : undefined;
      if (!hit) continue;
      hitEpic = hit.epic;
      if (hit.stop_level != null && Number.isFinite(hit.stop_level)) {
        gotSl = Number(hit.stop_level);
      }
      if (hit.profit_level != null && Number.isFinite(hit.profit_level)) {
        gotTp = Number(hit.profit_level);
      }

      let slOk = !needsSlProof;
      if (needsSlProof && hasLevel && wantSl != null && gotSl != null) {
        slOk = Math.abs(gotSl - wantSl) <= tolAbs;
      } else if (needsSlProof && !hasLevel && gotSl != null) {
        // stopDistance / native trail: accept when SL moved or gap≈dist vs mark
        const moved = beforeSl == null || Math.abs(gotSl - beforeSl) > tolAbs;
        if (moved) {
          slOk = true;
        } else if (hasDist && trailDist != null && hitEpic) {
          const q = await this.getQuote(hitEpic);
          if (q && Number.isFinite(q.mid)) {
            const gap = Math.abs(q.mid - gotSl);
            slOk =
              gap <= Number(trailDist) * 1.6 + 0.05 &&
              gap + 1e-9 >= Math.min(Number(trailDist), 0.45) * 0.5;
          }
        }
      }

      let tpOk = !needsTpProof;
      if (needsTpProof && wantTp != null && gotTp != null) {
        tpOk = Math.abs(gotTp - Number(wantTp)) <= tpTol;
      }

      if (slOk && tpOk) {
        return {
          ok: true,
          detail:
            res.detail ||
            [
              gotSl != null ? `sl_verified=${gotSl}` : '',
              gotTp != null ? `tp_verified=${gotTp}` : '',
            ]
              .filter(Boolean)
              .join(' '),
          order_id: res.deal_reference,
        };
      }
    }

    if (needsTpProof && (gotTp == null || wantTp == null || Math.abs(Number(gotTp) - Number(wantTp)) > tpTol)) {
      return {
        ok: false,
        detail:
          gotTp == null
            ? 'modify_tp_not_visible'
            : `modify_tp_unverified: want=${wantTp} got=${gotTp}`,
        order_id: res.deal_reference,
      };
    }
    if (gotSl == null && needsSlProof) {
      return {
        ok: false,
        detail: 'modify_sl_not_visible',
        order_id: res.deal_reference,
      };
    }
    if (hasLevel && wantSl != null && needsSlProof) {
      return {
        ok: false,
        detail: `modify_sl_unverified: want=${wantSl} got=${gotSl}`,
        order_id: res.deal_reference,
      };
    }
    return {
      ok: false,
      detail: `modify_sl_unchanged: before=${beforeSl} got=${gotSl}`,
      order_id: res.deal_reference,
    };
  }
}

/**
 * MT4 file-bridge adapter (from Check- protocol).
 * Writes OPEN/CLOSE/MODIFY JSON commands under bridgeRoot.
 */
export class Mt4FileBroker implements MasterBroker {
  readonly name = 'MT4_FILE';
  readonly paper = false;
  /** Partial CLOSE supported when EA honors `lot` (VS_MASTER v6.2+). */
  readonly supportsPartialClose = true;
  private processed = new Set<string>();
  /** Last Digits from market/latest.json (EA export) */
  private lastDigits: number | null = null;
  /** Last Point from market/latest.json */
  private lastPoint: number | null = null;
  /** Last chart Symbol() from market/latest.json (Check- OPEN identity) */
  private lastChartSymbol: string | null = null;

  constructor(private readonly bridgeRoot: string) {}

  /** Reader update_instance_instrument_state — tick size from EA when known. */
  instrumentTick(): { digits: number; point: number } | null {
    if (
      this.lastDigits != null &&
      this.lastPoint != null &&
      this.lastDigits >= 0 &&
      this.lastPoint > 0
    ) {
      return { digits: this.lastDigits, point: this.lastPoint };
    }
    return null;
  }

  /** EA chart symbol when known (OrderSend must use this, not Capital GOLD alias). */
  chartSymbol(): string | null {
    return this.lastChartSymbol;
  }

  private noteMarketMeta(m: Record<string, unknown> | null | undefined) {
    if (!m || typeof m !== 'object') return;
    const dig = Number(m.digits ?? m.Digits);
    const pt = Number(m.point ?? m.Point);
    if (Number.isFinite(dig) && dig >= 0 && dig <= 12) {
      this.lastDigits = Math.floor(dig);
    }
    if (Number.isFinite(pt) && pt > 0) {
      this.lastPoint = pt;
    }
    const sym = String(m.symbol ?? m.Symbol ?? '').trim();
    if (sym) this.lastChartSymbol = sym;
  }

  /**
   * Check- parity: OPEN uses market.symbol (EA Symbol()), not Capital/desk alias.
   * GOLD ↔ XAUUSD aliases resolve to the chart string; hard mismatches fail closed.
   */
  private resolveOpenSymbol(
    inputEpic: string
  ): { ok: true; symbol: string } | { ok: false; detail: string } {
    const market = this.readJson(join('market', 'latest.json'));
    this.noteMarketMeta(market as Record<string, unknown> | null);
    const chart = String(
      (market as any)?.symbol ?? (market as any)?.Symbol ?? this.lastChartSymbol ?? ''
    ).trim();
    if (!chart) {
      return { ok: true, symbol: inputEpic };
    }
    if (epicsMatch(chart, inputEpic)) {
      return { ok: true, symbol: chart };
    }
    return {
      ok: false,
      detail: `mt4_symbol_mismatch:chart=${chart} want=${inputEpic}`,
    };
  }

  private roundPrice(v: number | null | undefined): number | null {
    if (v == null || !Number.isFinite(v)) return null;
    if (this.lastDigits == null) return Number(v);
    const f = 10 ** this.lastDigits;
    return Math.round(Number(v) * f) / f;
  }

  async connect() {
    try {
      mkdirSync(join(this.bridgeRoot, 'commands'), { recursive: true });
      mkdirSync(join(this.bridgeRoot, 'acks'), { recursive: true });
      mkdirSync(join(this.bridgeRoot, 'market'), { recursive: true });
      mkdirSync(join(this.bridgeRoot, 'status'), { recursive: true });
      return { ok: true, detail: `mt4 bridge ${this.bridgeRoot}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private readJson(rel: string): any | null {
    const path = join(this.bridgeRoot, rel);
    // Reader atomic_read — refuse torn / mid-write status/market/acks
    const data = stableReadJson(path);
    return data ?? null;
  }

  /** Check clear_old_acks — keep newest N ack files, archive rest. */
  clearOldAcks(keep = 40): { kept: number; pruned: number } {
    const folder = join(this.bridgeRoot, 'acks');
    const result = { kept: 0, pruned: 0 };
    if (!existsSync(folder)) return result;
    const files = readdirSync(folder)
      .filter((f) => f.startsWith('ack_') && f.endsWith('.json'))
      .map((f) => {
        const full = join(folder, f);
        let mtime = 0;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        return { f, full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    const archive = join(folder, 'archive');
    for (let i = 0; i < files.length; i++) {
      const row = files[i]!;
      if (i < keep) {
        result.kept += 1;
        continue;
      }
      try {
        mkdirSync(archive, { recursive: true });
        renameSync(row.full, join(archive, row.f));
        result.pruned += 1;
      } catch {
        try {
          unlinkSync(row.full);
          result.pruned += 1;
        } catch {
          /* ignore */
        }
      }
    }
    return result;
  }

  /** Status file + age — Check-/Reader refuse stale bridge books. */
  private readStatusFile(): { data: any; age_ms: number } | null {
    const rel = join('status', 'latest.json');
    const path = join(this.bridgeRoot, rel);
    if (!existsSync(path)) return null;
    let mtime = Date.now();
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      /* keep now */
    }
    const data = this.readJson(rel);
    if (!data) return null;
    return { data, age_ms: Math.max(0, Date.now() - mtime) };
  }

  private statusStaleMs(): number {
    const raw = Number(
      process.env.MASTER_MT4_STATUS_STALE_MS ||
        process.env.MASTER_STALE_QUOTE_MS ||
        30_000
    );
    return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
  }

  private isStatusStale(ageMs: number): boolean {
    return ageMs > this.statusStaleMs();
  }

  private ackBudget() {
    // Default ~15s — real EA latency; tests override via MASTER_MT4_ACK_*
    const pollMs = Math.max(20, Number(process.env.MASTER_MT4_ACK_POLL_MS || 100));
    const polls = Math.max(1, Number(process.env.MASTER_MT4_ACK_POLLS || 150));
    return { pollMs, polls };
  }

  /** Block new OPEN while an unacked OPEN command still sits in the bridge. */
  private hasPendingOpenCommand(): boolean {
    return this.hasPendingCommand(['OPEN']);
  }

  /** Reader/Check: refuse stacking CLOSE/MODIFY while any control cmd is unacked. */
  private hasPendingCommand(actions: string[]): boolean {
    const want = new Set(actions.map((a) => a.toUpperCase()));
    const folder = join(this.bridgeRoot, 'commands');
    if (!existsSync(folder)) return false;
    for (const f of readdirSync(folder)) {
      if (!f.startsWith('cmd_') || !f.endsWith('.json')) continue;
      try {
        const payload = JSON.parse(readFileSync(join(folder, f), 'utf8'));
        const action = String(payload.action || '').toUpperCase();
        if (!want.has(action)) continue;
        const id = String(payload.id || '');
        if (!id) continue;
        if (!existsSync(join(this.bridgeRoot, 'acks', `ack_${id}.json`))) return true;
      } catch {
        /* ignore corrupt */
      }
    }
    return false;
  }

  private expireCommand(id: string) {
    const src = join(this.bridgeRoot, 'commands', `cmd_${id}.json`);
    if (!existsSync(src)) return;
    const destDir = join(this.bridgeRoot, 'commands', 'expired');
    mkdirSync(destDir, { recursive: true });
    try {
      renameSync(src, join(destDir, `cmd_${id}.json`));
    } catch {
      /* best-effort */
    }
  }

  private async waitAck(
    id: string
  ): Promise<{ ok: boolean; ack: any | null; detail: string }> {
    const ackPath = join(this.bridgeRoot, 'acks', `ack_${id}.json`);
    const { pollMs, polls } = this.ackBudget();
    for (let i = 0; i < polls; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (!existsSync(ackPath)) continue;
      try {
        const ack = stableReadJson(ackPath) as any;
        if (!ack || typeof ack !== 'object') continue;
        // Reader validate_ack_record — reject mismatched command id body
        const ackId = ack?.id != null ? String(ack.id) : '';
        if (ackId && ackId !== id) {
          return {
            ok: false,
            ack,
            detail: `mt4_ack_id_mismatch: want=${id} got=${ackId}`,
          };
        }
        if (!ack.ok) {
          const reason =
            ack.detail || ack.error || ack.error_message || 'nack';
          return { ok: false, ack, detail: `mt4_reject:${reason}` };
        }
        this.clearOldAcks(40);
        return { ok: true, ack, detail: 'acked' };
      } catch {
        /* keep polling */
      }
    }
    return { ok: false, ack: null, detail: 'mt4_ack_timeout' };
  }

  /** Reader atomic_write_text — fsync tmp then rename so INTENT and cmd agree on crash. */
  private writeCommandAtomic(id: string, payload: Record<string, unknown>) {
    const folder = join(this.bridgeRoot, 'commands');
    mkdirSync(folder, { recursive: true });
    const tmp = join(folder, `cmd_${id}.tmp`);
    const path = join(folder, `cmd_${id}.json`);
    writeFileSync(tmp, JSON.stringify(payload) + '\n', 'utf8');
    try {
      const fd = openSync(tmp, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* best-effort fsync */
    }
    renameSync(tmp, path);
    try {
      const fd = openSync(path, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* best-effort fsync */
    }
  }

  /** Cap/Check honesty: ACK alone is not enough — status stop_level must match. */
  private stopVerifyTol(wantSl: number): number {
    const point =
      this.lastPoint != null && this.lastPoint > 0 ? this.lastPoint : 0.05;
    return Math.max(point, Math.abs(wantSl) * 1e-5, 1e-6);
  }

  private async waitForTicketSizeReduced(
    positionId: string,
    beforeSize: number,
    wantClose: number
  ): Promise<{ ok: boolean; detail: string; remaining: number | null }> {
    const attempts =
      process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true' ? 4 : 8;
    let lastDetail = 'mt4_status_unread';
    let remaining: number | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) =>
          setTimeout(
            r,
            process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true'
              ? 15 + 10 * attempt
              : 80 + 60 * attempt
          )
        );
      }
      const listed = await this.listOpenPositions();
      if (!listed.ok) {
        lastDetail = listed.detail || 'mt4_status_unread';
        continue;
      }
      const still = listed.positions.find(
        (p) => p.position_id === String(positionId)
      );
      if (!still) return { ok: true, detail: 'flat', remaining: 0 };
      remaining = Number(still.size);
      if (
        Number.isFinite(remaining) &&
        remaining < beforeSize - 1e-9 &&
        remaining <= beforeSize - Math.min(wantClose, beforeSize) + 1e-6
      ) {
        return { ok: true, detail: 'reduced', remaining };
      }
      // Any proven shrink is enough (broker lot-step may round)
      if (Number.isFinite(remaining) && remaining < beforeSize - 1e-9) {
        return { ok: true, detail: 'reduced', remaining };
      }
      lastDetail = 'mt4_partial_size_unchanged';
    }
    return {
      ok: false,
      detail: `mt4_partial_unverified:${lastDetail}`,
      remaining,
    };
  }

  private async waitForTicketFlat(
    positionId: string
  ): Promise<{ ok: boolean; detail: string }> {
    const attempts =
      process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true' ? 4 : 8;
    let lastDetail = 'mt4_status_unread';
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) =>
          setTimeout(
            r,
            process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true'
              ? 15 + 10 * attempt
              : 80 + 60 * attempt
          )
        );
      }
      const listed = await this.listOpenPositions();
      if (!listed.ok) {
        lastDetail = listed.detail || 'mt4_status_unread';
        continue;
      }
      const still = listed.positions.some(
        (p) => p.position_id === String(positionId)
      );
      if (!still) return { ok: true, detail: 'flat' };
      lastDetail = 'mt4_close_still_open';
    }
    return { ok: false, detail: `mt4_close_unverified:${lastDetail}` };
  }

  private async waitForStatusStop(
    positionId: string,
    wantSl: number
  ): Promise<{ ok: boolean; observed: number | null }> {
    const tol = this.stopVerifyTol(wantSl);
    const attempts =
      process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true' ? 4 : 8;
    let observed: number | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) =>
          setTimeout(
            r,
            process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true'
              ? 15 + 10 * attempt
              : 80 + 60 * attempt
          )
        );
      }
      const listed = await this.listOpenPositions();
      const hit = listed.ok
        ? listed.positions.find((p) => p.position_id === String(positionId))
        : undefined;
      if (!hit) continue;
      if (hit.stop_level == null || !Number.isFinite(hit.stop_level)) continue;
      observed = Number(hit.stop_level);
      if (Math.abs(observed - wantSl) <= tol) {
        return { ok: true, observed };
      }
    }
    return { ok: false, observed };
  }

  /** Mirror SL proof for chart take-profit after OPEN/MODIFY. */
  private async waitForStatusProfit(
    positionId: string,
    wantTp: number
  ): Promise<{ ok: boolean; observed: number | null }> {
    const tol = this.stopVerifyTol(wantTp);
    const attempts =
      process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true' ? 4 : 8;
    let observed: number | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) =>
          setTimeout(
            r,
            process.env.VITEST || process.env.MASTER_CONFIRM_FAST === 'true'
              ? 15 + 10 * attempt
              : 80 + 60 * attempt
          )
        );
      }
      const listed = await this.listOpenPositions();
      const hit = listed.ok
        ? listed.positions.find((p) => p.position_id === String(positionId))
        : undefined;
      if (!hit) continue;
      if (hit.profit_level == null || !Number.isFinite(hit.profit_level)) continue;
      observed = Number(hit.profit_level);
      if (Math.abs(observed - wantTp) <= tol) {
        return { ok: true, observed };
      }
    }
    return { ok: false, observed };
  }

  /**
   * Prefer status open_level (OrderOpenPrice) over ACK fill.
   * Live EA historically ACK'd request Bid/Ask which hides slippage; status is broker truth.
   */
  private resolveOpenFill(ack: any | null, statusOpen: number | null | undefined): number | null {
    if (statusOpen != null && Number.isFinite(statusOpen) && statusOpen > 0) {
      return Number(statusOpen);
    }
    const ackFill = numOrNull(ack?.fill ?? ack?.price);
    if (ackFill != null && ackFill > 0) return ackFill;
    return null;
  }

  /** EA status open_time → epoch ms (null if missing/unparseable). */
  private statusPositionOpenMs(p: any): number | null {
    const rawT = p?.open_time ?? p?.OpenTime ?? p?.time ?? p?.Time ?? null;
    if (rawT == null || rawT === '') return null;
    if (typeof rawT === 'number' && Number.isFinite(rawT)) {
      return rawT < 1e12 ? rawT * 1000 : rawT;
    }
    const d = new Date(String(rawT));
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }

  /**
   * Wanted protective SL (+ optional TP) after OPEN — prove status levels,
   * else MODIFY+prove, else fail-close. Never treat SL-only proof as TP attached.
   * Public for restart ack-adopt (same path as live placeOrder).
   */
  async ensureProtectiveLevelsOrFail(input: {
    position_id: string;
    want_sl: number;
    want_tp?: number | null;
    order_id: string;
    epic: string;
  }): Promise<{ ok: true } | { ok: false; detail: string }> {
    return this.ensureOpenStopOrFail(input);
  }

  private async ensureOpenStopOrFail(input: {
    position_id: string;
    want_sl: number;
    want_tp?: number | null;
    order_id: string;
    epic: string;
  }): Promise<{ ok: true } | { ok: false; detail: string }> {
    const wantTp =
      input.want_tp != null && Number.isFinite(input.want_tp) && Number(input.want_tp) > 0
        ? Number(input.want_tp)
        : null;

    const provedSl = await this.waitForStatusStop(input.position_id, input.want_sl);
    const provedTp = wantTp
      ? await this.waitForStatusProfit(input.position_id, wantTp)
      : { ok: true as const, observed: null };
    if (provedSl.ok && provedTp.ok) return { ok: true };

    const mod = await this.modifyPosition({
      position_id: input.position_id,
      stop_level: input.want_sl,
      profit_level: wantTp ?? undefined,
    });
    if (!mod.ok) {
      const closed = await this.closePosition(input.position_id);
      const kind = /tp_unverified/i.test(String(mod.detail || ''))
        ? 'MT4_TP_ATTACH_FAILED'
        : 'MT4_SL_ATTACH_FAILED';
      return {
        ok: false,
        detail: `${kind}:mod=${mod.detail};close=${closed.ok ? 'ok' : closed.detail}`,
      };
    }

    const sl2 = await this.waitForStatusStop(input.position_id, input.want_sl);
    if (!sl2.ok) {
      const closed = await this.closePosition(input.position_id);
      return {
        ok: false,
        detail: `MT4_SL_ATTACH_FAILED:sl_unverified want=${input.want_sl} got=${sl2.observed};close=${closed.ok ? 'ok' : closed.detail}`,
      };
    }
    if (wantTp != null) {
      const tp2 = await this.waitForStatusProfit(input.position_id, wantTp);
      if (!tp2.ok) {
        const closed = await this.closePosition(input.position_id);
        return {
          ok: false,
          detail: `MT4_TP_ATTACH_FAILED:want=${wantTp} got=${tp2.observed};close=${closed.ok ? 'ok' : closed.detail}`,
        };
      }
    }
    return { ok: true };
  }

  async getQuote(epic: string): Promise<BrokerQuote | null> {
    const rel = join('market', 'latest.json');
    const path = join(this.bridgeRoot, rel);
    const m = this.readJson(rel);
    if (!m) return null;
    this.noteMarketMeta(m);
    const bid = Number(m.bid ?? m.Bid);
    const ask = Number(m.ask ?? m.Ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
    // Check-: stamp file mtime — Date.now() would hide stale bridge data from risk/manage
    let ts_ms = Date.now();
    try {
      if (existsSync(path)) ts_ms = statSync(path).mtimeMs;
    } catch {
      /* keep now */
    }
    // Prefer explicit market timestamp when EA exports one
    const rawTs = Number(m.ts_ms ?? m.time_ms ?? m.TimeMs ?? m.timestamp);
    if (Number.isFinite(rawTs) && rawTs > 1_000_000_000_000) ts_ms = rawTs;
    else if (Number.isFinite(rawTs) && rawTs > 1_000_000_000) ts_ms = rawTs * 1000;
    const rb = this.roundPrice(bid) ?? bid;
    const ra = this.roundPrice(ask) ?? ask;
    return {
      bid: rb,
      ask: ra,
      mid: (rb + ra) / 2,
      spread: ra - rb,
      epic: String(m.symbol || m.Symbol || epic),
      ts_ms,
      digits: this.lastDigits,
      point: this.lastPoint,
    };
  }

  async getAccount(): Promise<BrokerAccount | null> {
    const st = this.readStatusFile();
    if (!st) return null;
    if (this.isStatusStale(st.age_ms)) return null;
    const s = st.data;
    const equity = Number(s.equity ?? s.Equity ?? 0);
    const balance = Number(s.balance ?? s.Balance ?? 0);
    const margin = Number(s.margin ?? s.Margin ?? NaN);
    const marginFree = Number(s.margin_free ?? s.MarginFree ?? s.free_margin ?? NaN);
    // Reader: prefer AccountFreeMargin export over equity-margin estimate
    let available: number | null = null;
    if (Number.isFinite(marginFree)) {
      available = Math.max(0, marginFree);
    } else if (Number.isFinite(margin) && Number.isFinite(equity)) {
      available = Math.max(0, equity - margin);
    }
    const connected =
      typeof s.connected === 'boolean'
        ? s.connected
        : typeof s.Connected === 'boolean'
          ? s.Connected
          : true;
    const tradingFlag =
      typeof s.trading_allowed === 'boolean'
        ? s.trading_allowed
        : typeof s.trade_allowed === 'boolean'
          ? s.trade_allowed
          : typeof s.TradingAllowed === 'boolean'
            ? s.TradingAllowed
            : null;
    // Reader tradeable = connected && trade_allowed
    const trade_allowed =
      connected === false
        ? false
        : typeof tradingFlag === 'boolean'
          ? tradingFlag
          : null;
    return {
      equity,
      balance,
      currency: String(s.currency || 'USD'),
      available,
      trade_allowed,
    };
  }

  async listOpenPositions(epic?: string): Promise<ListOpenResult> {
    const st = this.readStatusFile();
    if (!st) {
      // Missing status file is ambiguous — treat as transport/bridge unread, not flat book
      return { ok: false, positions: [], detail: 'mt4_status_missing' };
    }
    if (this.isStatusStale(st.age_ms)) {
      return {
        ok: false,
        positions: [],
        detail: `mt4_status_stale age_ms=${Math.round(st.age_ms)}`,
      };
    }
    const s = st.data;
    const raw = Array.isArray(s?.positions) ? s.positions : [];
    const positions = raw
      .map((p: any) => {
        const openRaw = numOrNull(p.open ?? p.OpenPrice);
        return {
          position_id: String(p.ticket ?? p.Ticket ?? ''),
          epic: String(p.symbol ?? p.Symbol ?? ''),
          side: String(p.side || p.type || '').toUpperCase().includes('SELL')
            ? ('SELL' as const)
            : ('BUY' as const),
          size: Number(p.lot ?? p.Lots ?? 0),
          // Never invent 0 — orphan adopt must see missing entry as skip
          open_level: openRaw != null && openRaw > 0 ? openRaw : Number.NaN,
          stop_level: protectiveLevelOrNull(p.sl ?? p.SL),
          profit_level: protectiveLevelOrNull(p.tp ?? p.TP),
          upl: numOrNull(p.profit ?? p.Profit),
          opened_at: (() => {
            const rawT = p.open_time ?? p.OpenTime ?? p.time ?? p.Time ?? null;
            if (rawT == null || rawT === '') return null;
            if (typeof rawT === 'number' && Number.isFinite(rawT)) {
              const ms = rawT < 1e12 ? rawT * 1000 : rawT;
              return new Date(ms).toISOString();
            }
            const d = new Date(String(rawT));
            return Number.isFinite(d.getTime()) ? d.toISOString() : null;
          })(),
        };
      })
      .filter(
        (p: BrokerPosition) =>
          p.position_id &&
          Number.isFinite(p.open_level) &&
          p.open_level > 0 &&
          (!epic || epicsMatch(p.epic, epic))
      );
    return { ok: true, positions };
  }

  /**
   * Prefer EA-exported M1 bars from market/latest.json (chart truth) over Yahoo seed.
   */
  async getHistoryBars(_epic: string, maxBars = 60): Promise<BrokerHistoryBars> {
    const market = this.readJson(join('market', 'latest.json'));
    if (!market) {
      return { ok: false, bars: [], detail: 'mt4_market_missing' };
    }
    this.noteMarketMeta(market);
    const digits = this.lastDigits;
    const raw = Array.isArray(market.bars_m1) ? market.bars_m1 : [];
    const bars = raw
      .map((b: any) => {
        // EA VS_MASTER/CHECK export short keys t,o,h,l,c — accept both shapes
        let open = Number(b.open ?? b.Open ?? b.o);
        let high = Number(b.high ?? b.High ?? b.h);
        let low = Number(b.low ?? b.Low ?? b.l);
        let close = Number(b.close ?? b.Close ?? b.c);
        if (digits != null) {
          const f = 10 ** digits;
          open = Math.round(open * f) / f;
          high = Math.round(high * f) / f;
          low = Math.round(low * f) / f;
          close = Math.round(close * f) / f;
        }
        return {
          open,
          high,
          low,
          close,
          ts_ms: (() => {
            const t = b.ts_ms ?? b.time ?? b.Time ?? b.t;
            if (t == null || t === '') return undefined;
            if (typeof t === 'number' && Number.isFinite(t)) {
              return t < 1e12 ? t * 1000 : t;
            }
            const d = Date.parse(String(t));
            return Number.isFinite(d) ? d : undefined;
          })(),
        };
      })
      .filter((b: { open: number; high: number; low: number; close: number }) =>
        [b.open, b.high, b.low, b.close].every((n) => Number.isFinite(n) && n > 0)
      )
      .slice(-Math.max(10, maxBars));
    return {
      ok: bars.length >= 10,
      bars,
      detail:
        bars.length >= 10
          ? `mt4_bars_m1_${bars.length}`
          : `mt4_bars_m1_short_${bars.length}`,
      digits: this.lastDigits,
      point: this.lastPoint,
    };
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    if (this.processed.has(input.intent_id)) {
      return {
        ok: false,
        order_id: null,
        position_id: null,
        fill_price: null,
        detail: 'duplicate_intent',
        paper: false,
      };
    }
    // Durable republish guard (survives restart — memory Set alone does not)
    const blocked = findOpenIntentBlocker(input.intent_id);
    if (blocked) {
      return {
        ok: false,
        order_id: blocked.command_id,
        position_id: blocked.ticket,
        fill_price: blocked.fill_price,
        detail: `mt4_intent_already_${blocked.ack_status.toLowerCase()}`,
        paper: false,
      };
    }
    // Check- WAIT_CMD: refuse OPEN while any unacked control cmd is live
    // (CLOSE/MODIFY already mutex; OPEN used to only check pending OPEN).
    if (this.hasPendingCommand(['OPEN', 'CLOSE', 'MODIFY'])) {
      const openOnly = this.hasPendingOpenCommand();
      return {
        ok: false,
        order_id: null,
        position_id: null,
        fill_price: null,
        detail: openOnly ? 'mt4_pending_open' : 'mt4_pending_control_command',
        paper: false,
      };
    }
    this.processed.add(input.intent_id);
    const id = input.intent_id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || randomUUID().slice(0, 12);
    const openSym = this.resolveOpenSymbol(input.epic);
    if (!openSym.ok) {
      this.processed.delete(input.intent_id);
      return {
        ok: false,
        order_id: null,
        position_id: null,
        fill_price: null,
        detail: openSym.detail,
        paper: false,
      };
    }
    const slRounded = this.roundPrice(input.stop_level ?? null);
    const tpRounded = this.roundPrice(input.profit_level ?? null);
    const payload = {
      id,
      action: 'OPEN',
      symbol: openSym.symbol,
      side: input.side,
      lot: input.size,
      sl: slRounded ?? input.stop_level ?? 0,
      tp: tpRounded ?? input.profit_level ?? 0,
      magic: Number(process.env.MASTER_MT4_MAGIC || 50001) || 50001,
      reason: 'VS_MASTER',
    };
    // Snapshot tickets before INTENT/publish — late-fill must adopt only a *new* ticket.
    // Fail closed if status unread (empty set would wrongly adopt pre-existing).
    const preOpenTickets = new Set<string>();
    {
      const listed = await this.listOpenPositions(input.epic);
      if (!listed.ok) {
        this.processed.delete(input.intent_id);
        return {
          ok: false,
          order_id: null,
          position_id: null,
          fill_price: null,
          detail: `mt4_preopen_snapshot_unavailable:${listed.detail || 'unknown'}`,
          paper: false,
        };
      }
      for (const p of listed.positions) preOpenTickets.add(p.position_id);
    }
    // Reader: durable INTENT before control publish (crash between write and register)
    logTradeIntent({
      command_id: id,
      intent_id: input.intent_id,
      action: 'OPEN',
      side: input.side,
      volume: input.size,
      epic: openSym.symbol,
      sl: slRounded ?? input.stop_level ?? null,
      tp: tpRounded ?? input.profit_level ?? null,
      reason: 'INTENT',
    });
    this.writeCommandAtomic(id, payload);

    const waited = await this.waitAck(id);
    if (waited.ok && waited.ack) {
      // Archive immediately after ACK — attach/prove can take seconds; do not leave
      // cmd_ for EA restart re-OPEN while ensureOpenStopOrFail runs.
      this.expireCommand(id);
      const ticket = String(waited.ack.ticket || '');
      const opens = await this.listOpenPositions(input.epic);
      let hit =
        ticket && opens.ok
          ? opens.positions.find((p) => p.position_id === ticket)
          : undefined;
      if (!hit && !ticket && opens.ok) {
        // No ack ticket — only a *new* same side/size row (never positions[0]).
        hit = opens.positions.find(
          (p) =>
            !preOpenTickets.has(p.position_id) &&
            p.side === input.side &&
            Math.abs(p.size - input.size) < 1e-6
        );
      }
      const position_id = ticket || hit?.position_id || null;
      if (!position_id) {
        updateTradeAck(id, {
          ack_status: 'FAILED',
          detail: 'mt4_ack_no_bindable_ticket',
        });
        return {
          ok: false,
          order_id: id,
          position_id: null,
          fill_price: null,
          detail: 'mt4_ack_no_bindable_ticket',
          paper: false,
        };
      }
      const fill_price = this.resolveOpenFill(waited.ack, hit?.open_level);

      const wantProtectiveSl =
        input.stop_level != null && Number.isFinite(input.stop_level);
      if (wantProtectiveSl) {
        const guard = await this.ensureOpenStopOrFail({
          position_id,
          want_sl: slRounded ?? Number(input.stop_level),
          want_tp: tpRounded ?? input.profit_level ?? null,
          order_id: id,
          epic: input.epic,
        });
        if (!guard.ok) {
          updateTradeAck(id, {
            ack_status: 'FAILED',
            ticket: position_id,
            fill_price,
            detail: guard.detail,
          });
          return {
            ok: false,
            order_id: id,
            position_id: null,
            fill_price: null,
            detail: guard.detail,
            paper: false,
          };
        }
      }

      updateTradeAck(id, {
        ack_status: 'SUCCESS',
        ticket: position_id,
        fill_price,
        detail: 'ACK_SUCCESS',
      });
      return {
        ok: true,
        order_id: id,
        position_id,
        fill_price,
        fill_size: hit?.size ?? input.size,
        detail: `mt4_filled ticket=${ticket || hit?.position_id}`,
        paper: false,
      };
    }
    if (waited.ack && !waited.ok) {
      this.expireCommand(id);
      updateTradeAck(id, {
        ack_status: 'FAILED',
        detail: waited.detail || 'ACK_FAILED',
      });
      return {
        ok: false,
        order_id: id,
        position_id: null,
        fill_price: null,
        detail: waited.detail,
        paper: false,
      };
    }

    // Timeout — last-chance: EA may have filled without readable ack yet
    const opens = await this.listOpenPositions(input.epic);
    const late = opens.positions.find(
      (p) =>
        !preOpenTickets.has(p.position_id) &&
        p.side === input.side &&
        Math.abs(p.size - input.size) < 1e-6
    );
    if (late) {
      // Archive immediately — attach/prove calls MODIFY/CLOSE; live cmd_ would
      // trip hasPendingCommand → mt4_pending_control_command and block attach.
      this.expireCommand(id);
      const fill_price = late.open_level;
      const wantProtectiveSl =
        input.stop_level != null && Number.isFinite(input.stop_level);
      if (wantProtectiveSl) {
        const guard = await this.ensureOpenStopOrFail({
          position_id: late.position_id,
          want_sl: slRounded ?? Number(input.stop_level),
          want_tp: tpRounded ?? input.profit_level ?? null,
          order_id: id,
          epic: input.epic,
        });
        if (!guard.ok) {
          updateTradeAck(id, {
            ack_status: 'FAILED',
            ticket: late.position_id,
            fill_price,
            detail: guard.detail,
          });
          return {
            ok: false,
            order_id: id,
            position_id: null,
            fill_price: null,
            detail: guard.detail,
            paper: false,
          };
        }
      }
      updateTradeAck(id, {
        ack_status: 'SUCCESS',
        ticket: late.position_id,
        fill_price,
        detail: 'ACK_LATE_FILL',
      });
      return {
        ok: true,
        order_id: id,
        position_id: late.position_id,
        fill_price,
        fill_size: late.size,
        detail: `mt4_filled_late ticket=${late.position_id}`,
        paper: false,
      };
    }
    this.expireCommand(id);
    updateTradeAck(id, {
      ack_status: 'TIMEOUT',
      detail: 'ACK_TIMEOUT',
    });
    logMasterError({
      module: 'mt4.placeOrder',
      error_type: 'ACK_TIMEOUT',
      message: 'mt4_command_written_ack_timeout',
      context: { command_id: id, action: 'OPEN', epic: input.epic },
    });
    return {
      ok: false,
      order_id: id,
      position_id: null,
      fill_price: null,
      detail: 'mt4_command_written_ack_timeout',
      paper: false,
    };
  }

  async closePosition(position_id: string, opts?: { size?: number }) {
    if (this.hasPendingCommand(['OPEN', 'CLOSE', 'MODIFY'])) {
      return { ok: false, detail: 'mt4_pending_control_command' };
    }
    const partial =
      opts?.size != null && Number.isFinite(opts.size) && opts.size > 0;
    let beforeSize: number | null = null;
    {
      const beforeList = await this.listOpenPositions();
      const before = beforeList.ok
        ? beforeList.positions.find((p) => p.position_id === String(position_id))
        : undefined;
      if (before && Number.isFinite(before.size) && before.size > 0) {
        beforeSize = Number(before.size);
      }
    }
    // Never publish partial CLOSE without a proven before-size — EA may reduce
    // lots while host retries and over-closes.
    if (partial && beforeSize == null) {
      return { ok: false, detail: 'mt4_partial_no_before_size' };
    }
    const id = randomUUID().slice(0, 12);
    const closeLot = partial ? Number(opts!.size) : 0;
    const payload: Record<string, unknown> = {
      id,
      action: 'CLOSE',
      ticket: Number(position_id),
      reason: 'VS_MASTER',
    };
    if (partial) payload.lot = closeLot;
    // Reader: durable INTENT before control publish
    logTradeIntent({
      command_id: id,
      intent_id: `close:${position_id}:${id}`,
      action: 'CLOSE',
      side: null,
      volume: partial ? closeLot : 0,
      epic: '',
      ticket: String(position_id),
      sl: null,
      tp: null,
      reason: 'INTENT',
    });
    this.writeCommandAtomic(id, payload);

    const waited = await this.waitAck(id);
    if (waited.ok) {
      this.expireCommand(id);
      const fill =
        waited.ack?.fill != null
          ? Number(waited.ack.fill)
          : waited.ack?.price != null
            ? Number(waited.ack.price)
            : waited.ack?.close != null
              ? Number(waited.ack.close)
              : null;
      const fill_price = fill != null && Number.isFinite(fill) ? fill : null;
      // Missing ack profit must stay null — Number(null) would invent fill_pnl=0
      const fill_pnl = numOrNull(
        waited.ack?.profit ?? waited.ack?.Profit ?? waited.ack?.pnl
      );
      if (partial) {
        const reduced = await this.waitForTicketSizeReduced(
          String(position_id),
          beforeSize!,
          closeLot
        );
        if (!reduced.ok) {
          updateTradeAck(id, {
            ack_status: 'FAILED',
            ticket: String(position_id),
            fill_price,
            detail: reduced.detail,
          });
          return {
            ok: false,
            detail: reduced.detail,
            fill_price,
            fill_pnl,
            remaining_size: reduced.remaining,
          };
        }
        updateTradeAck(id, {
          ack_status: 'SUCCESS',
          ticket: String(position_id),
          fill_price,
          detail:
            reduced.remaining != null && reduced.remaining <= 1e-9
              ? 'ACK_SUCCESS_PARTIAL_FULL'
              : 'ACK_SUCCESS_PARTIAL',
        });
        return {
          ok: true,
          detail:
            reduced.remaining != null && reduced.remaining <= 1e-9
              ? `mt4_partial_became_full ticket=${position_id} before=${beforeSize} want=${closeLot}`
              : `mt4_partial_closed ticket=${position_id} rem=${reduced.remaining}`,
          fill_price,
          fill_pnl,
          remaining_size: reduced.remaining,
        };
      }
      // ACK alone is not enough — prove ticket gone from status (Cap/Check honesty)
      const flat = await this.waitForTicketFlat(String(position_id));
      if (!flat.ok) {
        updateTradeAck(id, {
          ack_status: 'FAILED',
          ticket: String(position_id),
          fill_price,
          detail: flat.detail,
        });
        return { ok: false, detail: flat.detail, fill_price, fill_pnl };
      }
      updateTradeAck(id, {
        ack_status: 'SUCCESS',
        ticket: String(position_id),
        fill_price,
        detail: 'ACK_SUCCESS',
      });
      return {
        ok: true,
        detail: `mt4_closed ticket=${waited.ack?.ticket || position_id}${
          fill_pnl != null ? ` pnl=${fill_pnl}` : ''
        }`,
        fill_price,
        fill_pnl,
        remaining_size: 0,
      };
    }
    if (waited.ack) {
      updateTradeAck(id, {
        ack_status: 'FAILED',
        detail: waited.detail || 'ACK_FAILED',
      });
      this.expireCommand(id);
      return { ok: false, detail: waited.detail };
    }
    this.expireCommand(id);
    // Late close reconcile — EA may have closed without readable ack (VS-System idempotent).
    // Multi-attempt like ACK success (status export can lag a single read).
    if (partial && beforeSize != null) {
      const reduced = await this.waitForTicketSizeReduced(
        String(position_id),
        beforeSize,
        closeLot
      );
      if (reduced.ok) {
        updateTradeAck(id, {
          ack_status: 'SUCCESS',
          ticket: String(position_id),
          detail: 'ACK_LATE_PARTIAL',
        });
        return {
          ok: true,
          detail:
            reduced.remaining === 0
              ? `mt4_partial_became_full_late ticket=${position_id}`
              : `mt4_partial_closed_late ticket=${position_id} rem=${reduced.remaining}`,
          fill_price: null,
          remaining_size: reduced.remaining,
        };
      }
    } else {
      const flat = await this.waitForTicketFlat(String(position_id));
      if (flat.ok) {
        updateTradeAck(id, {
          ack_status: 'SUCCESS',
          ticket: String(position_id),
          detail: 'ACK_LATE_CLOSE',
        });
        return {
          ok: true,
          detail: `mt4_closed_late ticket=${position_id}`,
          fill_price: null,
          remaining_size: 0,
        };
      }
    }
    updateTradeAck(id, {
      ack_status: 'TIMEOUT',
      detail: 'ACK_TIMEOUT',
    });
    logMasterError({
      module: 'mt4.closePosition',
      error_type: 'ACK_TIMEOUT',
      message: 'mt4_close_written_ack_timeout',
      context: { command_id: id, action: 'CLOSE', ticket: position_id },
    });
    return { ok: false, detail: 'mt4_close_written_ack_timeout' };
  }

  /** Check- protocol MODIFY — wait for ack + prove status stop_level (never ACK-only). */
  async modifyPosition(input: {
    position_id: string;
    stop_level?: number;
    profit_level?: number;
  }) {
    if (this.hasPendingCommand(['OPEN', 'CLOSE', 'MODIFY'])) {
      return { ok: false, detail: 'mt4_pending_control_command' };
    }
    // EA only understands sl/tp — refuse Capital-style trailingStop-only patches
    // that would re-ACK the same levels and falsely arm native_trail.
    if (input.stop_level == null && input.profit_level == null) {
      return { ok: false, detail: 'mt4_modify_requires_stop_or_profit_level' };
    }
    // EA OrderModify always writes both SL and TP. Omitted legs must be filled from
    // live status — defaulting missing tp/sl to 0 wipes chart TP on SL-only trails.
    let resolvedSl = input.stop_level;
    let resolvedTp = input.profit_level;
    const needSl = resolvedSl == null;
    const needTp = resolvedTp == null;
    if (needSl || needTp) {
      const listed = await this.listOpenPositions();
      const cur = listed.ok
        ? listed.positions.find((p) => p.position_id === String(input.position_id))
        : undefined;
      if (!cur) {
        return {
          ok: false,
          detail: listed.ok
            ? 'mt4_modify_position_not_found'
            : `mt4_modify_preserve_levels_unavailable:${listed.detail || 'status'}`,
        };
      }
      if (needSl) resolvedSl = cur.stop_level ?? undefined;
      if (needTp) resolvedTp = cur.profit_level ?? undefined;
    }
    const id = randomUUID().slice(0, 12);
    const slRounded = this.roundPrice(resolvedSl ?? null);
    const tpRounded = this.roundPrice(resolvedTp ?? null);
    const payload = {
      id,
      action: 'MODIFY',
      ticket: Number(input.position_id),
      sl: slRounded ?? resolvedSl ?? 0,
      tp: tpRounded ?? resolvedTp ?? 0,
      reason: 'VS_MASTER',
    };
    logTradeIntent({
      command_id: id,
      intent_id: `modify:${input.position_id}:${id}`,
      action: 'MODIFY',
      side: null,
      volume: 0,
      epic: '',
      ticket: String(input.position_id),
      sl: slRounded ?? resolvedSl ?? null,
      tp: tpRounded ?? resolvedTp ?? null,
      reason: 'INTENT',
    });
    this.writeCommandAtomic(id, payload);

    const waited = await this.waitAck(id);
    if (waited.ok) {
      // Archive ASAP after ACK — prove can take seconds; avoid restart re-MODIFY.
      this.expireCommand(id);
      // Prove every protective level we actually wrote (not ACK-only).
      // Use resolved payload values so preserved TP/SL cannot silently wipe.
      const proveSl = slRounded ?? resolvedSl ?? null;
      if (proveSl != null && Number.isFinite(proveSl) && proveSl > 0) {
        const proved = await this.waitForStatusStop(
          String(input.position_id),
          Number(proveSl)
        );
        if (!proved.ok) {
          updateTradeAck(id, {
            ack_status: 'FAILED',
            ticket: String(input.position_id),
            detail: `mt4_modify_sl_unverified: want=${proveSl} got=${proved.observed}`,
          });
          return {
            ok: false,
            detail: `mt4_modify_sl_unverified: want=${proveSl} got=${proved.observed}`,
            order_id: id,
          };
        }
      }
      const proveTp = tpRounded ?? resolvedTp ?? null;
      if (proveTp != null && Number.isFinite(proveTp) && proveTp > 0) {
        const proved = await this.waitForStatusProfit(
          String(input.position_id),
          Number(proveTp)
        );
        if (!proved.ok) {
          updateTradeAck(id, {
            ack_status: 'FAILED',
            ticket: String(input.position_id),
            detail: `mt4_modify_tp_unverified: want=${proveTp} got=${proved.observed}`,
          });
          return {
            ok: false,
            detail: `mt4_modify_tp_unverified: want=${proveTp} got=${proved.observed}`,
            order_id: id,
          };
        }
      }
      updateTradeAck(id, {
        ack_status: 'SUCCESS',
        ticket: String(input.position_id),
        detail: 'ACK_SUCCESS',
      });
      return { ok: true, detail: 'mt4_modify_acked', order_id: id };
    }
    if (waited.ack) {
      this.expireCommand(id);
      updateTradeAck(id, {
        ack_status: 'FAILED',
        detail: waited.detail || 'ACK_FAILED',
      });
      return { ok: false, detail: waited.detail, order_id: id };
    }
    this.expireCommand(id);
    // Lost ACK after EA OrderModify — late-prove status levels (same as ACK success path).
    // Otherwise noteModifyReject permanently skips a stop that may already be on the chart.
    const proveSl = slRounded ?? resolvedSl ?? null;
    const proveTp = tpRounded ?? resolvedTp ?? null;
    let lateOk = true;
    let lateDetail = '';
    if (proveSl != null && Number.isFinite(proveSl) && proveSl > 0) {
      const proved = await this.waitForStatusStop(
        String(input.position_id),
        Number(proveSl)
      );
      if (!proved.ok) {
        lateOk = false;
        lateDetail = `mt4_modify_sl_unverified: want=${proveSl} got=${proved.observed}`;
      }
    }
    if (lateOk && proveTp != null && Number.isFinite(proveTp) && proveTp > 0) {
      const proved = await this.waitForStatusProfit(
        String(input.position_id),
        Number(proveTp)
      );
      if (!proved.ok) {
        lateOk = false;
        lateDetail = `mt4_modify_tp_unverified: want=${proveTp} got=${proved.observed}`;
      }
    }
    if (lateOk && (proveSl != null && proveSl > 0 || proveTp != null && proveTp > 0)) {
      updateTradeAck(id, {
        ack_status: 'SUCCESS',
        ticket: String(input.position_id),
        detail: 'ACK_LATE_MODIFY',
      });
      return { ok: true, detail: 'mt4_modify_acked_late', order_id: id };
    }
    updateTradeAck(id, {
      ack_status: 'TIMEOUT',
      detail: lateDetail || 'ACK_TIMEOUT',
    });
    logMasterError({
      module: 'mt4.modifyPosition',
      error_type: 'ACK_TIMEOUT',
      message: 'mt4_modify_ack_timeout',
      context: {
        command_id: id,
        action: 'MODIFY',
        ticket: input.position_id,
        late_detail: lateDetail || null,
      },
    });
    return {
      ok: false,
      detail: lateDetail || 'mt4_modify_ack_timeout',
      order_id: id,
    };
  }

  /**
   * Reader/Check- style restart recovery — archive acked cmds, expire stale unacked.
   * Call before position sync so status orphans from late fills are adopted cleanly.
   * Also upgrades INTENT journal rows when ack files are discovered.
   */
  recoverPendingCommands(maxAgeMs = 120_000): {
    applied: number;
    expired: number;
    still_pending: number;
    details: string[];
  } {
    const folder = join(this.bridgeRoot, 'commands');
    const result = { applied: 0, expired: 0, still_pending: 0, details: [] as string[] };
    if (!existsSync(folder)) return result;
    const now = Date.now();
    for (const f of readdirSync(folder)) {
      if (!f.startsWith('cmd_') || !f.endsWith('.json')) continue;
      const path = join(folder, f);
      let payload: {
        id?: string;
        action?: string;
        symbol?: string;
        side?: string;
        lot?: number;
        ticket?: number | string;
        sl?: number;
        tp?: number;
      };
      try {
        payload = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        continue;
      }
      const id = String(payload.id || '');
      if (!id) continue;
      const action = String(payload.action || '').toUpperCase();
      const ackPath = join(this.bridgeRoot, 'acks', `ack_${id}.json`);
      if (existsSync(ackPath)) {
        try {
          const ack = JSON.parse(readFileSync(ackPath, 'utf8'));
          result.applied += 1;
          result.details.push(`${action}:${id}:ack_ok=${!!ack.ok}`);
          if (action === 'OPEN' || action === 'CLOSE' || action === 'MODIFY') {
            if (ack.ok) {
              updateTradeAck(id, {
                ack_status: 'SUCCESS',
                ticket: String(ack.ticket || '') || null,
                fill_price:
                  ack.fill != null
                    ? Number(ack.fill)
                    : ack.price != null
                      ? Number(ack.price)
                      : null,
                detail: 'RECOVER_ACK_SUCCESS',
              });
            } else {
              updateTradeAck(id, {
                ack_status: 'FAILED',
                detail: `RECOVER_ACK_FAIL:${ack.detail || ack.error || ack.error_message || ''}`,
              });
            }
          }
        } catch {
          result.applied += 1;
          result.details.push(`${action}:${id}:ack_corrupt`);
        }
        this.expireCommand(id);
        continue;
      }
      let age = maxAgeMs + 1;
      try {
        age = now - statSync(path).mtimeMs;
      } catch {
        /* treat as stale */
      }
      if (age >= maxAgeMs) {
        // OPEN expire: last-chance late fill (same as live ACK_LATE_FILL)
        if (action === 'OPEN') {
          const side = String(payload.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
          const lot = Number(payload.lot || 0);
          let cmdMtime = now - age;
          try {
            cmdMtime = statSync(path).mtimeMs;
          } catch {
            /* keep estimate */
          }
          const st = this.readStatusFile();
          if (st && !this.isStatusStale(st.age_ms)) {
            const raw = Array.isArray(st.data?.positions) ? st.data.positions : [];
            const late = raw.find((p: any) => {
              const pSide = String(p.side || p.type || '')
                .toUpperCase()
                .includes('SELL')
                ? 'SELL'
                : 'BUY';
              const pLot = Number(p.lot ?? p.Lots ?? 0);
              if (pSide !== side || Math.abs(pLot - lot) >= 1e-6) return false;
              // Require open_time at/after cmd publish (5s skew) — never adopt older orphans
              const ot = this.statusPositionOpenMs(p);
              if (ot == null) return false;
              return ot + 5_000 >= cmdMtime;
            });
            if (late) {
              const ticket = String(late.ticket ?? late.Ticket ?? '');
              const fill = numOrNull(late.open ?? late.OpenPrice);
              updateTradeAck(id, {
                ack_status: 'SUCCESS',
                ticket: ticket || null,
                fill_price: fill,
                detail: 'RECOVER_LATE_FILL',
              });
              this.expireCommand(id);
              result.applied += 1;
              result.details.push(`${action}:${id}:late_fill ticket=${ticket}`);
              continue;
            }
          }
        }
        // CLOSE/MODIFY: status late-reconcile (sync snapshot — recover is sync)
        if (action === 'CLOSE' || action === 'MODIFY') {
          const st = this.readStatusFile();
          if (st && !this.isStatusStale(st.age_ms)) {
            const raw = Array.isArray(st.data?.positions) ? st.data.positions : [];
            const ticketWant = String(payload.ticket ?? '');
            if (action === 'CLOSE' && ticketWant) {
              const still = raw.some(
                (p: any) => String(p.ticket ?? p.Ticket ?? '') === ticketWant
              );
              if (!still) {
                updateTradeAck(id, {
                  ack_status: 'SUCCESS',
                  ticket: ticketWant,
                  detail: 'RECOVER_LATE_CLOSE',
                });
                this.expireCommand(id);
                result.applied += 1;
                result.details.push(`${action}:${id}:late_close ticket=${ticketWant}`);
                continue;
              }
            }
            if (action === 'MODIFY' && ticketWant) {
              const hit = raw.find(
                (p: any) => String(p.ticket ?? p.Ticket ?? '') === ticketWant
              );
              if (hit) {
                const wantSl = Number(payload.sl ?? 0);
                const wantTp = Number(payload.tp ?? 0);
                const gotSl = Number(hit.sl ?? hit.SL ?? NaN);
                const gotTp = Number(hit.tp ?? hit.TP ?? NaN);
                const slOk =
                  !(wantSl > 0) ||
                  (Number.isFinite(gotSl) &&
                    Math.abs(gotSl - wantSl) <=
                      Math.max(0.05, Math.abs(wantSl) * 1e-5, 1e-6));
                const tpOk =
                  !(wantTp > 0) ||
                  (Number.isFinite(gotTp) &&
                    Math.abs(gotTp - wantTp) <=
                      Math.max(0.05, Math.abs(wantTp) * 1e-5, 1e-6));
                if (slOk && tpOk && (wantSl > 0 || wantTp > 0)) {
                  updateTradeAck(id, {
                    ack_status: 'SUCCESS',
                    ticket: ticketWant,
                    detail: 'RECOVER_LATE_MODIFY',
                  });
                  this.expireCommand(id);
                  result.applied += 1;
                  result.details.push(
                    `${action}:${id}:late_modify ticket=${ticketWant}`
                  );
                  continue;
                }
              }
            }
          }
        }
        this.expireCommand(id);
        result.expired += 1;
        result.details.push(`${action}:${id}:expired_age_ms=${age}`);
        if (action === 'OPEN' || action === 'CLOSE' || action === 'MODIFY') {
          updateTradeAck(id, {
            ack_status: 'TIMEOUT',
            detail: 'RECOVER_EXPIRED',
          });
        }
      } else {
        result.still_pending += 1;
        result.details.push(`${action}:${id}:pending_age_ms=${age}`);
      }
    }
    const pruned = this.clearOldAcks(40);
    if (pruned.pruned) {
      result.details.push(`acks_pruned:${pruned.pruned}`);
    }
    return result;
  }

  /**
   * Reader apply_ack_to_instance_state — OPEN SUCCESS tickets not yet in local book.
   * Prefer journal (survives cmd expire); supplement with live ack files if present.
   */
  adoptOpenFromAckJournal(bookedIds: Set<string>): {
    adopted: Array<{
      command_id: string;
      intent_id: string;
      ticket: string;
      side: Side;
      volume: number;
      epic: string;
      fill_price: number | null;
      sl: number | null;
      tp: number | null;
    }>;
  } {
    const fromJournal = findOpenSuccessUnbooked(bookedIds);
    const adopted: Array<{
      command_id: string;
      intent_id: string;
      ticket: string;
      side: Side;
      volume: number;
      epic: string;
      fill_price: number | null;
      sl: number | null;
      tp: number | null;
    }> = [];
    const seen = new Set<string>();
    for (const r of fromJournal) {
      if (!r.ticket || !r.side || seen.has(r.ticket)) continue;
      seen.add(r.ticket);
      adopted.push({
        command_id: r.command_id,
        intent_id: r.intent_id,
        ticket: r.ticket,
        side: r.side,
        volume: r.volume,
        epic: r.epic,
        fill_price: r.fill_price,
        sl: r.sl,
        tp: r.tp,
      });
    }
    return { adopted };
  }
}

function numOrNull(v: unknown): number | null {
  // Number(null) and Number('') are 0 — treat missing fields as null
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * MT4 OrderStopLoss/TakeProfit are 0 when naked — Check- treats <=0 as no level.
 * Never keep 0 as a real protective price.
 */
export function protectiveLevelOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  if (n == null || !(n > 0)) return null;
  return n;
}

/** @internal exported for unit tests */
export function mt4NumOrNull(v: unknown): number | null {
  return numOrNull(v);
}

export function listMt4AckFiles(bridgeRoot: string): string[] {
  const folder = join(bridgeRoot, 'acks');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => f.startsWith('ack_'));
}
