/** Unified broker interface — strategy never talks to a concrete broker directly. */
import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { Side } from './types.js';

export type BrokerQuote = {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  epic: string;
  ts_ms: number;
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

export interface MasterBroker {
  readonly name: string;
  readonly paper: boolean;
  connect(): Promise<{ ok: boolean; detail: string }>;
  getQuote(epic: string): Promise<BrokerQuote | null>;
  getAccount(): Promise<BrokerAccount | null>;
  listOpenPositions(epic?: string): Promise<ListOpenResult>;
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  closePosition(position_id: string): Promise<{ ok: boolean; detail: string }>;
  modifyPosition?(input: {
    position_id: string;
    stop_level?: number;
    profit_level?: number;
  }): Promise<{ ok: boolean; detail: string; order_id?: string }>;
}

/** In-memory paper broker — real decision/risk path, simulated fills. */
export class PaperBroker implements MasterBroker {
  readonly name = 'PAPER';
  readonly paper = true;
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
    return { equity: this.equity, balance: this.balance, currency: 'GBP' };
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

  async closePosition(position_id: string) {
    const p = this.positions.get(position_id);
    if (!p) return { ok: false, detail: 'not_found' };
    const q = this.lastQuote;
    if (q) {
      const exit = p.side === 'BUY' ? q.bid : q.ask;
      const pnl =
        p.side === 'BUY' ? (exit - p.open_level) * p.size : (p.open_level - exit) * p.size;
      this.equity += pnl;
      this.balance = this.equity;
    }
    this.positions.delete(position_id);
    return { ok: true, detail: 'paper_closed' };
  }

  async modifyPosition(input: {
    position_id: string;
    stop_level?: number;
    profit_level?: number;
  }) {
    const p = this.positions.get(input.position_id);
    if (!p) return { ok: false, detail: 'not_found' };
    if (input.stop_level != null) p.stop_level = input.stop_level;
    if (input.profit_level != null) p.profit_level = input.profit_level;
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
        upl: 0,
      });
    }
  }

  /** Mark-to-market open positions from quote. */
  markToMarket() {
    const q = this.lastQuote;
    if (!q) return;
    for (const p of this.positions.values()) {
      const mid = q.mid;
      p.upl = p.side === 'BUY' ? (mid - p.open_level) * p.size : (p.open_level - mid) * p.size;
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
  private session: any = null;
  private processed = new Set<string>();
  /** Last dealingRules seen per epic from markets quote */
  private dealRulesByEpic = new Map<
    string,
    { minSize: number; maxSize: number; step: number }
  >();

  constructor(
    private readonly deps: {
      acquire: (input: any) => Promise<{ ok: boolean; session?: any; detail: string }>;
      quote: (session: any, epic: string) => Promise<any>;
      list: (session: any) => Promise<any>;
      create: (session: any, input: any) => Promise<any>;
      close: (session: any, dealId: string) => Promise<any>;
      modify?: (
        session: any,
        input: { dealId: string; stopLevel?: number | null; profitLevel?: number | null }
      ) => Promise<{ ok: boolean; detail: string; deal_reference?: string }>;
      confirm?: (
        session: any,
        ref: string
      ) => Promise<{
        ok: boolean;
        deal_id?: string;
        fill_level?: number;
        detail: string;
        rejected?: boolean;
        pending?: boolean;
      }>;
      account?: (
        session: any
      ) => Promise<{ equity: number; balance: number; currency: string } | null>;
      credentials: any;
    }
  ) {}

  async connect() {
    const opened = await this.deps.acquire(this.deps.credentials);
    if (!opened.ok || !opened.session) return { ok: false, detail: opened.detail };
    this.session = opened.session;
    return { ok: true, detail: 'capital connected' };
  }

  async getQuote(epic: string): Promise<BrokerQuote | null> {
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
    return {
      bid: q.bid,
      ask: q.ask,
      mid: q.mid,
      spread: q.ask - q.bid,
      epic: q.epic || epic,
      ts_ms: Date.now(),
    };
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
      .map((p) => ({
        position_id: p.deal_id,
        epic: p.epic,
        side: p.direction as Side,
        size: p.size,
        open_level: p.open_level ?? 0,
        stop_level: p.stop_level ?? null,
        profit_level: p.profit_level ?? null,
        upl: p.upl ?? null,
        opened_at: p.opened_at ?? null,
      }));
    return { ok: true, positions };
  }

  private async waitConfirm(dealReference: string): Promise<{
    ok: boolean;
    deal_id?: string;
    fill_level?: number;
    detail: string;
    rejected?: boolean;
  }> {
    if (!this.deps.confirm) {
      return { ok: false, detail: 'no_confirm_dep' };
    }
    const { CAPITAL_CONFIRM_POLL_MS } = await import('./capitalConfirm.js');
    for (const delay of CAPITAL_CONFIRM_POLL_MS) {
      await new Promise((r) => setTimeout(r, delay));
      const conf = await this.deps.confirm(this.session, dealReference);
      if (conf.rejected) {
        return { ok: false, rejected: true, detail: conf.detail };
      }
      if (conf.ok && conf.deal_id) {
        return {
          ok: true,
          deal_id: conf.deal_id,
          fill_level: conf.fill_level,
          detail: conf.detail,
        };
      }
      if (!conf.pending) {
        // Non-pending failure — keep polling briefly in case of lag
        continue;
      }
    }
    return { ok: false, detail: `confirm_timeout ref=${dealReference}` };
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
      isCapitalSizeError,
    } = await import('./capitalSize.js');
    const epicKey = String(input.epic || '').toUpperCase();
    const liveRules = this.dealRulesByEpic.get(epicKey);
    const sized = liveRules
      ? {
          ...normalizeCapitalDealSize(input.size, liveRules),
          rules: liveRules,
        }
      : normalizeSizeForEpic(input.epic, input.size);
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
    if (opened.deal_reference) {
      const conf = await this.waitConfirm(opened.deal_reference);
      if (conf.rejected) {
        // Confirm rejected — still fail-close any same-side fill that landed
        const listed = await this.listOpenPositions(input.epic);
        const ghost = listed.positions.find(
          (p) =>
            p.side === input.side &&
            (Math.abs(p.size - orderSize) < 1e-6 || Math.abs(p.size - input.size) < 1e-6)
        );
        if (ghost) {
          await this.deps.close(this.session, ghost.position_id);
          return {
            ok: false,
            order_id: opened.deal_reference || null,
            position_id: null,
            fill_price: null,
            fill_size: null,
            detail: `capital_rejected_fail_closed:${conf.detail}`,
            paper: false,
          };
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
      if (conf.ok && conf.deal_id) {
        position_id = conf.deal_id;
        fill_price = conf.fill_level ?? null;
      }
    }

    if (!position_id) {
      const listed = await this.listOpenPositions(input.epic);
      const hit =
        listed.positions.find(
          (p) => p.side === input.side && Math.abs(p.size - orderSize) < 1e-6
        ) ||
        listed.positions.find(
          (p) => p.side === input.side && Math.abs(p.size - input.size) < 1e-6
        );
      if (hit) {
        position_id = hit.position_id;
        fill_price = hit.open_level || null;
      }
    }

    // Never accept dealReference alone as a live fill — fail-close same-size ghost if present
    if (!position_id) {
      const listed = await this.listOpenPositions(input.epic);
      const ghost = listed.positions.find(
        (p) => p.side === input.side && Math.abs(p.size - orderSize) < 1e-6
      );
      if (ghost) {
        await this.deps.close(this.session, ghost.position_id);
        return {
          ok: false,
          order_id: opened.deal_reference || null,
          position_id: null,
          fill_price: null,
          fill_size: null,
          detail: `capital_unconfirmed_fail_closed:${opened.detail}`,
          paper: false,
        };
      }
      return {
        ok: false,
        order_id: opened.deal_reference || null,
        position_id: null,
        fill_price: null,
        fill_size: null,
        detail: `capital_unconfirmed:${opened.detail}`,
        paper: false,
      };
    }

    // Attach / verify SL after fill
    if (input.stop_level != null && this.deps.modify) {
      const wantSl = input.stop_level;
      let attached = false;
      for (let widen = 0; widen < 4 && !attached; widen++) {
        const mid = fill_price ?? wantSl;
        const pad = widen * Math.max(0.5, Math.abs(mid) * 0.0005);
        const sl =
          input.side === 'BUY' ? wantSl - pad : wantSl + pad;
        const mod = await this.deps.modify(this.session, {
          dealId: position_id,
          stopLevel: sl,
          profitLevel: input.profit_level ?? null,
        });
        if (mod.ok && mod.deal_reference) {
          await this.waitConfirm(mod.deal_reference);
        }
        const listed = await this.listOpenPositions(input.epic);
        const hit = listed.positions.find((p) => p.position_id === position_id);
        if (hit?.stop_level != null && Number.isFinite(hit.stop_level)) {
          attached = true;
          break;
        }
        if (!mod.ok && !isCapitalStopLevelReject(mod.detail)) break;
      }
      if (!attached && needAttach) {
        // Fail-close naked position — never leave unprotected after forced bare open
        await this.deps.close(this.session, position_id);
        return {
          ok: false,
          order_id: opened.deal_reference || null,
          position_id: null,
          fill_price: null,
          fill_size: null,
          detail: 'CAPITAL_SL_ATTACH_FAILED',
          paper: false,
        };
      }
    }

    const listedFinal = await this.listOpenPositions(input.epic);
    const filled = listedFinal.positions.find((p) => p.position_id === position_id);
    return {
      ok: true,
      order_id: opened.deal_reference || null,
      position_id,
      fill_price,
      fill_size: filled?.size ?? orderSize,
      detail: `capital_open deal=${position_id}${fill_price != null ? ` fill=${fill_price}` : ''}`,
      paper: false,
    };
  }

  async closePosition(position_id: string) {
    if (!this.session) return { ok: false, detail: 'not_connected' };
    const res = await this.deps.close(this.session, position_id);
    return { ok: !!res.ok, detail: res.detail || '' };
  }

  async modifyPosition(input: {
    position_id: string;
    stop_level?: number;
    profit_level?: number;
  }) {
    if (!this.session) return { ok: false, detail: 'not_connected' };
    if (!this.deps.modify) return { ok: false, detail: 'modify_not_wired' };
    const res = await this.deps.modify(this.session, {
      dealId: input.position_id,
      stopLevel: input.stop_level,
      profitLevel: input.profit_level,
    });
    if (res.ok && res.deal_reference) {
      await this.waitConfirm(res.deal_reference);
    }
    return { ok: !!res.ok, detail: res.detail || '', order_id: res.deal_reference };
  }
}

/**
 * MT4 file-bridge adapter (from Check- protocol).
 * Writes OPEN/CLOSE/MODIFY JSON commands under bridgeRoot.
 */
export class Mt4FileBroker implements MasterBroker {
  readonly name = 'MT4_FILE';
  readonly paper = false;
  private processed = new Set<string>();

  constructor(private readonly bridgeRoot: string) {}

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
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  private ackBudget() {
    // Default ~15s — real EA latency; tests override via MASTER_MT4_ACK_*
    const pollMs = Math.max(20, Number(process.env.MASTER_MT4_ACK_POLL_MS || 100));
    const polls = Math.max(1, Number(process.env.MASTER_MT4_ACK_POLLS || 150));
    return { pollMs, polls };
  }

  /** Block new OPEN while an unacked OPEN command still sits in the bridge. */
  private hasPendingOpenCommand(): boolean {
    const folder = join(this.bridgeRoot, 'commands');
    if (!existsSync(folder)) return false;
    for (const f of readdirSync(folder)) {
      if (!f.startsWith('cmd_') || !f.endsWith('.json')) continue;
      try {
        const payload = JSON.parse(readFileSync(join(folder, f), 'utf8'));
        if (String(payload.action || '').toUpperCase() !== 'OPEN') continue;
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
        const ack = JSON.parse(readFileSync(ackPath, 'utf8'));
        if (!ack.ok) {
          return { ok: false, ack, detail: `mt4_reject:${ack.detail || 'nack'}` };
        }
        return { ok: true, ack, detail: 'acked' };
      } catch {
        /* keep polling */
      }
    }
    return { ok: false, ack: null, detail: 'mt4_ack_timeout' };
  }

  async getQuote(epic: string): Promise<BrokerQuote | null> {
    const m = this.readJson(join('market', 'latest.json'));
    if (!m) return null;
    const bid = Number(m.bid ?? m.Bid);
    const ask = Number(m.ask ?? m.Ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
    return {
      bid,
      ask,
      mid: (bid + ask) / 2,
      spread: ask - bid,
      epic: String(m.symbol || m.Symbol || epic),
      ts_ms: Date.now(),
    };
  }

  async getAccount(): Promise<BrokerAccount | null> {
    const s = this.readJson(join('status', 'latest.json'));
    if (!s) return null;
    return {
      equity: Number(s.equity ?? s.Equity ?? 0),
      balance: Number(s.balance ?? s.Balance ?? 0),
      currency: String(s.currency || 'USD'),
    };
  }

  async listOpenPositions(epic?: string): Promise<ListOpenResult> {
    const s = this.readJson(join('status', 'latest.json'));
    if (!s) {
      // Missing status file is ambiguous — treat as transport/bridge unread, not flat book
      return { ok: false, positions: [], detail: 'mt4_status_missing' };
    }
    const raw = Array.isArray(s?.positions) ? s.positions : [];
    const positions = raw
      .map((p: any) => ({
        position_id: String(p.ticket ?? p.Ticket ?? ''),
        epic: String(p.symbol ?? p.Symbol ?? ''),
        side: String(p.side || p.type || '').toUpperCase().includes('SELL')
          ? ('SELL' as const)
          : ('BUY' as const),
        size: Number(p.lot ?? p.Lots ?? 0),
        open_level: Number(p.open ?? p.OpenPrice ?? 0),
        stop_level: numOrNull(p.sl ?? p.SL),
        profit_level: numOrNull(p.tp ?? p.TP),
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
      }))
      .filter((p: BrokerPosition) => p.position_id && (!epic || epicsMatch(p.epic, epic)));
    return { ok: true, positions };
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
    if (this.hasPendingOpenCommand()) {
      return {
        ok: false,
        order_id: null,
        position_id: null,
        fill_price: null,
        detail: 'mt4_pending_open',
        paper: false,
      };
    }
    this.processed.add(input.intent_id);
    const id = input.intent_id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || randomUUID().slice(0, 12);
    const payload = {
      id,
      action: 'OPEN',
      symbol: input.epic,
      side: input.side,
      lot: input.size,
      sl: input.stop_level ?? 0,
      tp: input.profit_level ?? 0,
      magic: 50001,
      reason: 'VS_MASTER',
    };
    const folder = join(this.bridgeRoot, 'commands');
    mkdirSync(folder, { recursive: true });
    const tmp = join(folder, `cmd_${id}.tmp`);
    const path = join(folder, `cmd_${id}.json`);
    writeFileSync(tmp, JSON.stringify(payload) + '\n', 'utf8');
    renameSync(tmp, path);

    const waited = await this.waitAck(id);
    if (waited.ok && waited.ack) {
      const ticket = String(waited.ack.ticket || '');
      const opens = await this.listOpenPositions(input.epic);
      const hit =
        opens.positions.find((p) => p.position_id === ticket) || opens.positions[0];
      return {
        ok: true,
        order_id: id,
        position_id: ticket || hit?.position_id || null,
        fill_price: hit?.open_level ?? null,
        fill_size: hit?.size ?? input.size,
        detail: `mt4_filled ticket=${ticket || hit?.position_id}`,
        paper: false,
      };
    }
    if (waited.ack && !waited.ok) {
      this.expireCommand(id);
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
      (p) => p.side === input.side && Math.abs(p.size - input.size) < 1e-6
    );
    if (late) {
      return {
        ok: true,
        order_id: id,
        position_id: late.position_id,
        fill_price: late.open_level,
        fill_size: late.size,
        detail: `mt4_filled_late ticket=${late.position_id}`,
        paper: false,
      };
    }
    this.expireCommand(id);
    return {
      ok: false,
      order_id: id,
      position_id: null,
      fill_price: null,
      detail: 'mt4_command_written_ack_timeout',
      paper: false,
    };
  }

  async closePosition(position_id: string) {
    const id = randomUUID().slice(0, 12);
    const folder = join(this.bridgeRoot, 'commands');
    mkdirSync(folder, { recursive: true });
    const payload = { id, action: 'CLOSE', ticket: Number(position_id), reason: 'VS_MASTER' };
    const tmp = join(folder, `cmd_${id}.tmp`);
    const path = join(folder, `cmd_${id}.json`);
    writeFileSync(tmp, JSON.stringify(payload) + '\n', 'utf8');
    renameSync(tmp, path);

    const waited = await this.waitAck(id);
    if (waited.ok) {
      return { ok: true, detail: `mt4_closed ticket=${waited.ack?.ticket || position_id}` };
    }
    if (waited.ack) {
      return { ok: false, detail: waited.detail };
    }
    this.expireCommand(id);
    return { ok: false, detail: 'mt4_close_written_ack_timeout' };
  }

  /** Check- protocol MODIFY — wait for ack like OPEN/CLOSE (never lie ok:true on write). */
  async modifyPosition(input: {
    position_id: string;
    stop_level?: number;
    profit_level?: number;
  }) {
    const id = randomUUID().slice(0, 12);
    const folder = join(this.bridgeRoot, 'commands');
    mkdirSync(folder, { recursive: true });
    const payload = {
      id,
      action: 'MODIFY',
      ticket: Number(input.position_id),
      sl: input.stop_level ?? 0,
      tp: input.profit_level ?? 0,
      reason: 'VS_MASTER',
    };
    const tmp = join(folder, `cmd_${id}.tmp`);
    const path = join(folder, `cmd_${id}.json`);
    writeFileSync(tmp, JSON.stringify(payload) + '\n', 'utf8');
    renameSync(tmp, path);

    const waited = await this.waitAck(id);
    if (waited.ok) {
      return { ok: true, detail: 'mt4_modify_acked', order_id: id };
    }
    if (waited.ack) {
      this.expireCommand(id);
      return { ok: false, detail: waited.detail, order_id: id };
    }
    this.expireCommand(id);
    return { ok: false, detail: 'mt4_modify_ack_timeout', order_id: id };
  }

  /**
   * Reader/Check- style restart recovery — archive acked cmds, expire stale unacked.
   * Call before position sync so status orphans from late fills are adopted cleanly.
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
      let payload: { id?: string; action?: string };
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
        this.expireCommand(id);
        result.expired += 1;
        result.details.push(`${action}:${id}:expired_age_ms=${age}`);
      } else {
        result.still_pending += 1;
        result.details.push(`${action}:${id}:pending_age_ms=${age}`);
      }
    }
    return result;
  }
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function listMt4AckFiles(bridgeRoot: string): string[] {
  const folder = join(bridgeRoot, 'acks');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => f.startsWith('ack_'));
}
