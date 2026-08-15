import { pool } from '../db/pool.js';
import { decrypt } from '../security/encryption.js';
import {
  acquireCapitalSession,
  closeCapitalPosition,
  confirmCapitalDeal,
  createCapitalPosition,
  fetchCapitalMarketQuote,
  fetchCapitalMinutePrices,
  fetchCapitalPrices,
  listCapitalOpenPositions,
  updateCapitalStop,
  type CapitalMarketQuote,
  type CapitalOpenPosition,
  type CapitalSession,
} from './capitalCom.js';
import { emitToClient } from './clientEvents.js';
import { mapTradeType } from './tradePresentation.js';
import {
  observeClosedBars,
  normalizeRegime,
  REGIME_NAMES,
  type RegimeName,
} from './regimes.js';
import { decideBestOutcomeExit, favorableMove } from './exitManage.js';
import { effectiveBias, resolveTrendBias, TREND_LOOKBACK_10S, type TrendBias } from './entryFromRegime.js';
import { DecisionCodes, type DecisionCode } from './decisionCodes.js';
import { runtimeBuildInfo } from './runtimeBuild.js';
import {
  multiFeedOwnsOhlc,
  pickOhlcMid,
  readMultiFeedPrice,
  type MultiFeedPrice,
  type MultiFeedLeg,
} from './robotReader.js';
import { buildFresherRefs, detectStaleQuoteAdverse } from './staleQuoteGuard.js';
import {
  aggregateSecondsToTen,
  emptyTenSecState,
  publicOhlc10s,
  updateTenSecondOhlc,
  type TenSecBar,
  type TenSecState,
} from './tenSecondOhlc.js';
import { evaluateRisk } from '../vs-core/riskCore.js';
import {
  executeTradeIntent,
  newDecisionId,
  newIntentId,
} from '../vs-core/executionCore.js';
import { STRATEGY_VERSION, CONFIG_VERSION } from '../vs-core/versions.js';
import { getClientTradingRegistry } from '../vs-core/clientTrading.js';
import { evaluateStrategy, strategyToDecisionCode } from '../vs-core/strategyCore.js';
import { FeedManager } from '../vs-core/feedManager.js';
import { getDurableOrderStore } from '../vs-core/durableOrderStore.js';
import {
  buildMoneyPathRisk,
  marketStatusAllowsTrading,
} from '../vs-core/moneyPathRisk.js';
import { allowEntryFromPrimaryFeed } from '../vs-core/primaryFeedGate.js';

export type RobotTick = {
  at: string;
  /** SCAN = reading market, no setup yet. WAIT is legacy alias only — not a trading mode. */
  phase: 'READ' | 'DECIDE' | 'ORDER' | 'SCAN' | 'ERROR' | 'INFO' | 'MANAGE' | 'EXIT';
  bid: number | null;
  ask: number | null;
  mid: number | null;
  detail: string;
  /** Machine reason — NO_SETUP / BLOCKED_TECHNICAL / SIGNAL_*. Never invent UNKNOWN. */
  code?: DecisionCode;
};

export type RobotSession = {
  id: string;
  account_id: number;
  client_id: number;
  account_name: string;
  client_name: string;
  environment: string;
  epic: string;
  display_name: string;
  lot_size: number;
  running: boolean;
  trading_enabled: boolean;
  started_at: string;
  stopped_at: string | null;
  ticks: RobotTick[];
  last_quote_at: string | null;
  last_mid: number | null;
  /** Raw Capital.com snapshot.marketStatus for this epic (TRADEABLE/CLOSED/…). */
  capital_market_status: string | null;
  last_deal_reference: string | null;
  deal_id: string | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  unrealized: number | null;
  mode: 'FLAT' | 'MANAGE' | 'ENTRY';
  regime: RegimeName;
  trend_bias?: TrendBias;
  orders_placed: number;
  exits_done: number;
  reads_ok: number;
  reads_fail: number;
  open_side: 'BUY' | 'SELL' | null;
  safety_sl: number | null;
  error: string | null;
  /** When false, robot never invents entries — pipeline fan-out only */
  entry_enabled: boolean;
  ohlc_10s: {
    last_o: number | null;
    last_h: number | null;
    last_l: number | null;
    last_c: number | null;
    forming_c: number | null;
    body_pct: number | null;
    market: 'MOVING' | 'QUIET' | 'SEEDING';
  };
  feed_source?: 'MULTI' | 'LOCAL' | 'NONE';
  feed_contributing?: number;
  feed_sender_count?: number;
  feed_agreement?: string | null;
  feed_legs?: MultiFeedLeg[];
  decision_chain?: {
    feeds: string;
    ohlc: string;
    regime: string;
    setup: string | null;
    action: string;
  };
};

type Internal = RobotSession & {
  timer: ReturnType<typeof setInterval> | null;
  connection_id: number;
  closed_at_ms: number;
  peak_favorable: number;
  /** Last time we logged "market closed" (throttle ticks) */
  last_market_closed_tick_ms: number;
  cadence_ms: number;
  ohlcState: TenSecState;
  last_second_fetch_ms: number;
  last_closed_bar_key: string;
  closedBars: TenSecBar[];
  last_minute_fetch_ms: number;
  minuteCandles: Array<{ open: number; close: number }>;
  last_multi_feed_ms: number;
  multiFeed: MultiFeedPrice | null;
  sl_tighten_done: boolean;
  /** Prevent overlapping robotCycle runs on the same session */
  cycle_in_flight: boolean;
  feedManager: FeedManager;
};

const ACTIVE_CADENCE_MS = 2_000;
const CLOSED_MARKET_CADENCE_MS = 90_000;
const CLOSED_MARKET_TICK_EVERY_MS = 5 * 60_000;

/** Capital LIVE quote ≠ TRADEABLE. Only these statuses allow entries/manage. FAIL CLOSED. */
function marketAllowsTrading(status: string | null | undefined): boolean {
  return marketStatusAllowsTrading(status);
}

function formatCapitalParkDetail(
  epic: string,
  status: string | null | undefined,
  feeds: string,
): string {
  const st = String(status || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
  return (
    `Capital ${epic} marketStatus=${st} — park (LIVE cena ≠ TRADEABLE; orderi tikai TRADEABLE/OPEN) · ${feeds}`
  );
}

function setRobotCadence(s: Internal, ms: number) {
  if (s.timer && s.cadence_ms === ms) return;
  if (s.timer) clearInterval(s.timer);
  s.cadence_ms = ms;
  s.timer = setInterval(() => void robotCycle(s), ms);
}

const sessions = new Map<string, Internal>();
const MAX_TICKS = 200;

/** Stable robot id from account + epic — never Date.now(), never random */
export function robotIdFor(accountId: number, epic: string): string {
  const safe = String(epic)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
  return `r${accountId}_${safe || 'market'}`;
}

async function loadCreds(connectionId: number): Promise<Record<string, string>> {
  const { rows } = await pool.query(
    `SELECT credential_type, ciphertext, iv, tag
     FROM api_credential_metadata WHERE broker_connection_id = $1`,
    [connectionId]
  );
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.credential_type as string] = decrypt(
      row.ciphertext as string,
      row.iv as string,
      row.tag as string
    );
  }
  return out;
}

function pushTick(s: Internal, tick: Omit<RobotTick, 'at'>) {
  const detail =
    tick.code && !String(tick.detail || '').startsWith(`[${tick.code}]`)
      ? `[${tick.code}] ${tick.detail}`
      : tick.detail;
  s.ticks.unshift({ ...tick, detail, at: new Date().toISOString() });
  if (s.ticks.length > MAX_TICKS) s.ticks.length = MAX_TICKS;
}

function publicSession(s: Internal): RobotSession {
  const {
    timer: _t,
    connection_id: _c,
    closed_at_ms: _closed,
    peak_favorable: _peak,
    last_market_closed_tick_ms: _lmc,
    cadence_ms: _cad,
    ohlcState: _ohlc,
    last_second_fetch_ms: _sec,
    last_closed_bar_key: _bar,
    closedBars: _bars,
    last_minute_fetch_ms: _minFetch,
    minuteCandles: _mins,
    last_multi_feed_ms: _mf,
    multiFeed: _multi,
    cycle_in_flight: _cif,
    feedManager: _fm,
    ...rest
  } = s;
  return {
    ...rest,
    ohlc_10s: publicOhlc10s(s.ohlcState),
    feed_source: rest.feed_source,
    feed_contributing: s.multiFeed?.contributing ?? rest.feed_contributing ?? 0,
    feed_sender_count: s.multiFeed?.sender_count ?? rest.feed_sender_count ?? 0,
    feed_agreement: s.multiFeed?.agreement ?? rest.feed_agreement ?? null,
    feed_legs: s.feed_legs ?? s.multiFeed?.legs ?? rest.feed_legs ?? [],
    decision_chain: buildDecisionChain(s),
  };
}

function buildDecisionChain(s: Internal): NonNullable<RobotSession['decision_chain']> {
  const ohlc = publicOhlc10s(s.ohlcState);
  const ohlcLine =
    ohlc.last_c != null
      ? `O${Number(ohlc.last_o).toFixed(2)}→C${Number(ohlc.last_c).toFixed(2)} ${ohlc.market}`
      : 'SEEDING';
  const feeds = `${s.multiFeed?.contributing ?? s.feed_contributing ?? 0}/${
    s.multiFeed?.sender_count ?? s.feed_sender_count ?? 0
  } ${s.feed_source || 'NONE'} ${s.multiFeed?.agreement || s.feed_agreement || ''}`.trim();
  let action = 'SCAN';
  if (!s.running) action = 'STOPPED';
  else if (s.open_side) action = `MANAGE ${s.open_side}`;
  else if (s.mode === 'ENTRY') action = 'SCAN ENTRY';
  return {
    feeds,
    ohlc: ohlcLine,
    regime: effectiveRegimeName(s),
    setup: s.trend_bias ? `bias ${s.trend_bias}` : null,
    action,
  };
}

/** Regime field only — never invent TREND_* from bias alone. */
export function effectiveRegimeName(s: {
  regime?: string | null;
  trend_bias?: TrendBias | string | null;
}): string {
  void s.trend_bias;
  const r = String(s.regime || 'UNKNOWN').toUpperCase();
  return r || 'UNKNOWN';
}

/** Bias unlock must not rewrite UNKNOWN regime into TREND_* (keep bias separate). */
function applyBiasRegimeUnlock(_s: Internal) {
  // no-op: regime stays authoritative; trend_bias is a separate field
}

export function robotBoardMeta(sessions: RobotSession[]) {
  const activeRegimes = [
    ...new Set(
      sessions
        .filter((s) => s.running)
        .map((s) => effectiveRegimeName(s))
        .filter((r) => r && r !== 'UNKNOWN' && r !== 'SEEDING'),
    ),
  ];
  const maxFeeds = sessions.reduce(
    (n, s) => Math.max(n, s.feed_sender_count || 0, s.feed_legs?.length || 0),
    0
  );
  const contributing = sessions.reduce((n, s) => Math.max(n, s.feed_contributing || 0), 0);
  const build = runtimeBuildInfo();
  return {
    regimes: [...REGIME_NAMES],
    trade_types: ['BUY LONG', 'SELL LONG', 'BUY SCALP', 'SELL SCALP'],
    active_regimes: activeRegimes,
    feed_sender_count: maxFeeds,
    feed_contributing: contributing,
    git_sha: build.git_sha,
    entry_brain: build.entry_brain,
    chain: '10s OHLC → REGIME(context) → SETUP EVIDENCE → evaluateStrategy · Node robotDesk',
    note: `BUILD ${build.git_sha} · NODE BRAIN · regime=context · SL=0.20% of price · ${build.trend_minutes}-min`,
  };
}

function applyRobotRegime(s: Internal, bars?: TenSecBar[]) {
  const incoming = bars?.length
    ? bars
    : s.ohlcState.last_closed
      ? [s.ohlcState.last_closed]
      : [];
  if (!incoming.length) return;
  const snap = observeClosedBars(s.epic, incoming, s.display_name);
  s.regime = snap.current;
  for (const bar of incoming) {
    if (!bar || !Number.isFinite(bar.close)) continue;
    const last = s.closedBars[s.closedBars.length - 1];
    const same =
      last &&
      Math.abs(last.open - bar.open) < 1e-9 &&
      Math.abs(last.close - bar.close) < 1e-9 &&
      Math.abs(last.high - bar.high) < 1e-9;
    if (same) continue;
    s.closedBars.push(bar);
  }
  if (s.closedBars.length > TREND_LOOKBACK_10S) {
    s.closedBars.splice(0, s.closedBars.length - TREND_LOOKBACK_10S);
  }
}

function clearTradeState(s: Internal) {
  s.open_side = null;
  s.deal_id = null;
  s.entry_price = null;
  s.entry_at = null;
  s.mfe = 0;
  s.mae = 0;
  s.peak_favorable = 0;
  s.peak_retention = null;
  s.unrealized = null;
  s.safety_sl = null;
  s.mode = 'FLAT';
  s.sl_tighten_done = false;
}

/**
 * Safety SL = 0.20% of price (at least Capital min×2.5 so broker accepts it).
 */
function safetyStopLevel(
  direction: 'BUY' | 'SELL',
  mid: number,
  bid: number | null,
  ask: number | null,
  spread: number | null,
  minStopDistance: number | null,
  loosen = 1
): number {
  const ref =
    direction === 'BUY'
      ? bid != null && Number.isFinite(bid)
        ? bid
        : mid
      : ask != null && Number.isFinite(ask)
        ? ask
        : mid;
  const abs = Math.max(Math.abs(ref), 1e-9);
  const spr =
    spread != null && Number.isFinite(spread) && spread > 0
      ? spread
      : bid != null && ask != null
        ? Math.max(ask - bid, 0)
        : abs * 0.00005;

  const pctCushion = abs * 0.002; // 0.20% of price
  const brokerMin =
    minStopDistance != null && Number.isFinite(minStopDistance) && minStopDistance > 0
      ? minStopDistance
      : 0;
  const floor = abs >= 1000 ? 0.5 : abs >= 100 ? 0.25 : abs >= 10 ? 0.05 : abs >= 1 ? 0.0005 : 0.00005;
  const dist =
    Math.max(pctCushion, brokerMin * 2.5, spr * 8, floor) * Math.max(loosen, 1);

  const raw = direction === 'BUY' ? ref - dist : ref + dist;
  if (abs >= 1000) return Math.round(raw * 10) / 10;
  if (abs >= 100) return Math.round(raw * 100) / 100;
  if (abs >= 1) return Math.round(raw * 10000) / 10000;
  return Math.round(raw * 1e6) / 1e6;
}

/** stopDistance from 0.20% of price (≥ 2.5× Capital min points). */
function safetyStopDistancePts(
  mid: number,
  minPts: number,
  pointSize: number | null
): number {
  const abs = Math.max(Math.abs(mid), 1e-9);
  const pct = abs * 0.002;
  let fromPct = minPts * 2.5;
  if (pointSize != null && pointSize > 0) {
    fromPct = Math.max(fromPct, pct / pointSize);
  }
  const distPts = Math.max(minPts * 2.5, fromPct, minPts + 1e-9);
  return distPts >= 10 ? Math.ceil(distPts) : Math.round(distPts * 100) / 100;
}

function expectedStopFromDistance(
  direction: 'BUY' | 'SELL',
  mid: number,
  bid: number | null,
  ask: number | null,
  stopDistancePts: number,
  pointSize: number | null
): number | null {
  const ref =
    direction === 'BUY'
      ? bid != null && Number.isFinite(bid)
        ? bid
        : mid
      : ask != null && Number.isFinite(ask)
        ? ask
        : mid;
  const ps = pointSize != null && pointSize > 0 ? pointSize : null;
  if (ps == null) return null;
  const dist = stopDistancePts * ps;
  return direction === 'BUY' ? ref - dist : ref + dist;
}

function updateExcursion(s: Internal, mid: number) {
  if (!s.open_side || s.entry_price == null) return;
  const fav = favorableMove(s.open_side, s.entry_price, mid);
  s.unrealized = fav;
  if (fav > s.mfe) {
    s.mfe = fav;
    s.peak_favorable = mid;
  }
  if (fav < s.mae) s.mae = fav;
  s.peak_retention = s.mfe > 0 ? Math.max(0, fav / s.mfe) : null;
}

/** Exact id only — never returns a different robot */
export function getRobotSession(id?: string | null): RobotSession | null {
  const key = String(id || '').trim();
  if (!key || key === 'active') return null;
  const s = sessions.get(key);
  return s ? publicSession(s) : null;
}

/** Resolve by stable id OR account_id+epic — never confuses robots */
export function resolveRobotSession(opts: {
  id?: string | null;
  account_id?: number | null;
  epic?: string | null;
}): RobotSession | null {
  const byId = getRobotSession(opts.id);
  if (byId) return byId;

  const accountId = Number(opts.account_id);
  const epic = String(opts.epic || '').trim();
  if (Number.isFinite(accountId) && accountId > 0 && epic) {
    const key = robotIdFor(accountId, epic);
    const s = sessions.get(key);
    if (s) return publicSession(s);
    for (const sess of sessions.values()) {
      if (sess.account_id === accountId && sess.epic === epic) return publicSession(sess);
    }
  }
  return null;
}

export function listRobotSessions(): RobotSession[] {
  return [...sessions.values()]
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .map(publicSession);
}

/** True when Node robotDesk is the entry brain for this account+epic (ignore stale C++ intents). */
export function hasEntryEnabledRobot(accountId: number, epic: string): boolean {
  const want = String(epic || '').trim().toUpperCase();
  for (const s of sessions.values()) {
    if (
      s.account_id === accountId &&
      s.running &&
      s.entry_enabled &&
      String(s.epic || '').toUpperCase() === want
    ) {
      return true;
    }
  }
  return false;
}

export async function stopEntryRobotsForAccount(accountId: number): Promise<void> {
  for (const s of [...sessions.values()]) {
    if (s.account_id === accountId && s.running && s.entry_enabled) {
      await stopRobotSession(s.id);
    }
  }
}

/** Stop manage-only robots that are already flat (client STOP, no open trade). */
export async function stopFlatManageRobotsForAccount(accountId: number): Promise<void> {
  for (const s of [...sessions.values()]) {
    if (s.account_id === accountId && s.running && !s.entry_enabled && !s.open_side) {
      await stopRobotSession(s.id);
    }
  }
}

export async function stopRobotSession(id: string): Promise<RobotSession | null> {
  const s = sessions.get(id);
  if (!s) return null;
  s.running = false;
  s.trading_enabled = false;
  s.entry_enabled = false;
  s.stopped_at = new Date().toISOString();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  if (s.client_id) {
    getClientTradingRegistry().stop(s.client_id, s.account_id);
  }
  pushTick(s, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: s.last_mid,
    detail: 'ROBOT STOPPED by operator',
  });
  if (s.client_id) {
    emitToClient(s.client_id, {
      type: 'robot_stopped',
      robot_id: s.id,
      market: s.epic,
      robot_status: 'STOPPED',
    });
  }
  return publicSession(s);
}

function matchOpenOnEpic(
  positions: CapitalOpenPosition[],
  epic: string
): CapitalOpenPosition | null {
  const want = epic.trim().toLowerCase();
  return (
    positions.find((p) => p.epic.trim().toLowerCase() === want) ||
    positions.find((p) => p.deal_id === epic) ||
    null
  );
}

async function resolveDealId(
  session: CapitalSession,
  s: Internal,
  dealRef: string | undefined
): Promise<string | null> {
  if (s.deal_id) return s.deal_id;
  if (dealRef) {
    const conf = await confirmCapitalDeal(session, dealRef);
    if (conf.ok && conf.deal_id) {
      s.deal_id = conf.deal_id;
      pushTick(s, {
        phase: 'INFO',
        bid: null,
        ask: null,
        mid: s.last_mid,
        detail: conf.detail,
      });
      return conf.deal_id;
    }
  }
  const listed = await listCapitalOpenPositions(session);
  if (listed.ok) {
    const hit = matchOpenOnEpic(listed.positions, s.epic);
    if (hit) {
      s.deal_id = hit.deal_id;
      return hit.deal_id;
    }
  }
  return null;
}

async function exitTrade(
  session: CapitalSession,
  s: Internal,
  quote: { bid: number | null; ask: number | null; mid: number | null },
  reason: string
) {
  const dealId = await resolveDealId(session, s, s.last_deal_reference || undefined);
  if (!dealId) {
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: 'EXIT blocked — no dealId (cannot close). Will keep MANAGE, no new entry.',
    });
    s.mode = 'MANAGE';
    return;
  }

  pushTick(s, {
    phase: 'DECIDE',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: `EXIT NOW · ${reason}`,
  });

  const result = await closeCapitalPosition(session, dealId);
  if (!result.ok) {
    s.error = result.detail;
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `CLOSE FAIL: ${result.detail}`,
    });
    return;
  }

  s.exits_done += 1;
  s.last_deal_reference = result.deal_reference || s.last_deal_reference;
  s.closed_at_ms = Date.now();
  s.error = null;
  pushTick(s, {
    phase: 'EXIT',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: `CLOSED ${s.open_side} ${s.display_name} · ${result.detail} · ${reason}`,
  });
  if (s.client_id) {
    emitToClient(s.client_id, {
      type: 'trade_closed',
      robot_id: s.id,
      market: s.epic,
      display_name: s.display_name,
      side: s.open_side,
      trade_type: mapTradeType(s.open_side, null, s.regime),
      lot_size: s.lot_size,
      reason,
    });
  }

  try {
    await pool.query(
      `UPDATE positions SET status = 'CLOSED', closed_at = NOW()
       WHERE broker_account_id = $1 AND status = 'OPEN'
         AND instrument_id IN (
           SELECT id FROM capital_markets WHERE broker_connection_id = $2 AND epic = $3
         )`,
      [s.account_id, s.connection_id, s.epic]
    );
  } catch {
    /* best effort */
  }

  clearTradeState(s);
}

async function enterTrade(
  session: CapitalSession,
  s: Internal,
  direction: 'BUY' | 'SELL',
  quote: CapitalMarketQuote,
  reason: string,
  setupType?: string | null
) {
  // HARD RULE: never entry while any trade open on this epic
  const listed = await listCapitalOpenPositions(session);
  if (listed.ok) {
    const existing = matchOpenOnEpic(listed.positions, s.epic);
    if (existing) {
      s.open_side = existing.direction;
      s.deal_id = existing.deal_id;
      s.entry_price = existing.open_level ?? quote.mid;
      s.entry_at = s.entry_at || new Date().toISOString();
      s.mode = 'MANAGE';
      if (existing.stop_level != null) s.safety_sl = existing.stop_level;
      pushTick(s, {
        phase: 'ERROR',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        code: DecisionCodes.DUPLICATE_PREVENTED,
        detail: `BLOCKED_TECHNICAL · duplicate — broker already open ${existing.direction} dealId=${existing.deal_id} · no new entry`,
      });
      return;
    }
  } else {
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      code: DecisionCodes.BLOCKED_TECHNICAL,
      detail: `BLOCKED_TECHNICAL · cannot reconcile positions before order (${listed.detail || 'list failed'})`,
    });
    return;
  }

  pushTick(s, {
    phase: 'DECIDE',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    code: DecisionCodes.SIGNAL_CREATED,
    detail: `ENTRY ${direction} · ${reason} · lot=${s.lot_size}`,
  });

  const mid = quote.mid;
  if (mid == null || !Number.isFinite(mid)) {
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      code: DecisionCodes.ERROR_NO_QUOTE,
      detail: 'ENTRY blocked — no mid for safety SL',
    });
    return;
  }

  // Mobile STOP blocks new entries even if robot process still runs.
  const clientTrading = getClientTradingRegistry();
  const clientEnabled =
    s.client_id > 0
      ? clientTrading.isTradingEnabled(s.client_id, s.account_id) && s.entry_enabled
      : s.entry_enabled;

  // Pre-compute stop — Risk forbids entry without stop; never fall back to naked order.
  const minPts = quote.min_stop_points;
  const minPrice = quote.min_stop_distance ?? null;
  const unit = (quote.min_stop_unit || 'POINTS').toUpperCase();
  const useDistance = minPts != null && minPts > 0 && !unit.includes('PERCENT');
  const loosenSteps = [1, 1.08, 1.16, 1.28];

  let plannedStopDistance: number | null = null;
  let plannedStopLevel: number | null = null;
  if (useDistance) {
    const basePts = safetyStopDistancePts(mid, minPts!, quote.point_size ?? null);
    const distPts = Math.max(basePts, minPts! * 2.5);
    plannedStopDistance = distPts >= 10 ? Math.ceil(distPts) : Math.round(distPts * 100) / 100;
    plannedStopLevel = expectedStopFromDistance(
      direction,
      mid,
      quote.bid,
      quote.ask,
      plannedStopDistance,
      quote.point_size ?? null
    );
  } else {
    plannedStopLevel = safetyStopLevel(
      direction,
      mid,
      quote.bid,
      quote.ask,
      quote.spread ?? null,
      minPrice,
      1
    );
  }

  const stopAttached = plannedStopDistance != null || plannedStopLevel != null;
  const existing = matchOpenOnEpic(listed.positions, s.epic);
  const orderStore = getDurableOrderStore();
  const riskBuild = buildMoneyPathRisk({
    client_id: s.client_id,
    account_id: s.account_id,
    epic: s.epic,
    direction,
    size: s.lot_size,
    client_trading_enabled: clientEnabled,
    quote,
    feedManager: s.feedManager,
    orderStore,
    // Session acquired for this enterTrade — CST + security token required (fail closed if missing)
    session_healthy: Boolean(session?.cst && session?.securityToken),
    reconcile_clean: listed.ok,
    has_open_position: !!existing,
    stop_attached: stopAttached,
    operating_mode: String(s.environment || '').toLowerCase() === 'live' ? 'LIVE' : 'DEMO',
    live_trading_enabled: process.env.LIVE_TRADING_ENABLED === 'true',
    max_spread: null,
  });
  if (riskBuild.ok === false) {
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      code: DecisionCodes.BLOCKED_TECHNICAL,
      detail: `BLOCKED_TECHNICAL · ${riskBuild.code}: ${riskBuild.reason}`,
    });
    return;
  }
  const riskCtx = riskBuild.ctx;
  const risk = evaluateRisk(riskCtx);
  if (risk.ok === false) {
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      code: DecisionCodes.BLOCKED_TECHNICAL,
      detail: `BLOCKED_TECHNICAL · ${risk.code}: ${risk.reason}`,
    });
    return;
  }

  pushTick(s, {
    phase: 'INFO',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    code: DecisionCodes.RISK_ACCEPTED,
    detail: `RISK_ACCEPTED · ${direction} lot=${s.lot_size}`,
  });

  let stopLevel: number | null = null;
  let usedStopDistance: number | null = null;
  let submitTimedOut = false;

  const intentId = newIntentId();
  const decisionId = newDecisionId();
  /** Box avoids TS control-flow narrowing of closed-over lets after await. */
  const brokerBox: {
    current: Awaited<ReturnType<typeof createCapitalPosition>> | null;
  } = { current: null };
  const trySubmit = async (
    params: { stopDistance?: number; stopLevel?: number },
    clientOrderId: string
  ): Promise<Awaited<ReturnType<typeof createCapitalPosition>>> => {
    try {
      return await createCapitalPosition(session, {
        epic: s.epic,
        direction,
        size: s.lot_size,
        clientOrderId,
        ...params,
      });
    } catch (e) {
      submitTimedOut = true;
      return {
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
        deal_reference: undefined,
        status: 0,
        json: null,
      };
    }
  };

  // Execution via durable order store — confirm before POSITION_OPEN.
  const exec = await executeTradeIntent(
    {
      intent_id: intentId,
      decision_id: decisionId,
      client_id: s.client_id,
      account_id: s.account_id,
      epic: s.epic,
      direction,
      size: s.lot_size,
      stop_distance: plannedStopDistance,
      stop_level: plannedStopLevel,
      strategy_version: STRATEGY_VERSION,
      config_version: CONFIG_VERSION,
      market_snapshot_id: `desk_${s.id}_${Date.now()}`,
    },
    riskCtx,
    {
      orderStore,
      submit: async (intent, clientOrderId) => {
        // SL distance attempts (loosen only on stop-validation rejects — not network timeout)
        if (useDistance && intent.stop_distance != null) {
          for (const loosen of loosenSteps) {
            if (submitTimedOut) break;
            const basePts = safetyStopDistancePts(mid, minPts!, quote.point_size ?? null);
            const distPts = Math.max(basePts * loosen, minPts! * 2.5);
            const stopDistance =
              distPts >= 10 ? Math.ceil(distPts) : Math.round(distPts * 100) / 100;
            const expect = expectedStopFromDistance(
              direction,
              mid,
              quote.bid,
              quote.ask,
              stopDistance,
              quote.point_size ?? null
            );
            pushTick(s, {
              phase: 'INFO',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              code: DecisionCodes.ORDER_SUBMITTING,
              detail: `SL 0.20% stopDistance=${stopDistance} pts (Capital min=${minPts} · ~level ${
                expect ?? 'n/a'
              } · x${loosen})`,
            });
            brokerBox.current = await trySubmit({ stopDistance }, clientOrderId);
            if (brokerBox.current.ok) {
              usedStopDistance = stopDistance;
              stopLevel = expect;
              return {
                ok: true,
                deal_reference: brokerBox.current.deal_reference,
                detail: brokerBox.current.detail,
              };
            }
            if (submitTimedOut) {
              return { ok: false, timed_out: true, detail: brokerBox.current.detail };
            }
            if (!/stop|distance|validation|reject|attached|level/i.test(brokerBox.current.detail)) {
              return { ok: false, detail: brokerBox.current.detail };
            }
            pushTick(s, {
              phase: 'INFO',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: `SL distance rejected — loosen x${loosen}: ${brokerBox.current.detail}`,
            });
          }
        }

        for (const loosen of loosenSteps) {
          if (submitTimedOut) break;
          const level = safetyStopLevel(
            direction,
            mid,
            quote.bid,
            quote.ask,
            quote.spread ?? null,
            minPrice,
            loosen
          );
          const dist = direction === 'BUY' ? mid - level : level - mid;
          pushTick(s, {
            phase: 'INFO',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            code: DecisionCodes.ORDER_SUBMITTING,
            detail: `SL 0.20% try stopLevel=${level} (dist≈${dist.toFixed(5)} · minPrice=${
              minPrice ?? 'n/a'
            } · spread=${quote.spread ?? 'n/a'} · x${loosen})`,
          });
          brokerBox.current = await trySubmit({ stopLevel: level }, clientOrderId);
          if (brokerBox.current.ok) {
            stopLevel = level;
            return {
              ok: true,
              deal_reference: brokerBox.current.deal_reference,
              detail: brokerBox.current.detail,
            };
          }
          if (submitTimedOut) {
            return { ok: false, timed_out: true, detail: brokerBox.current.detail };
          }
          if (!/stop|distance|validation|reject|attached|level/i.test(brokerBox.current.detail)) {
            return { ok: false, detail: brokerBox.current.detail };
          }
          pushTick(s, {
            phase: 'INFO',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: `SL level rejected — loosen x${loosen}: ${brokerBox.current.detail}`,
          });
        }

        // VS CORE: never open without SL
        return {
          ok: false,
          detail: `RISK_REJECTED_NO_STOP — safety SL not accepted (${brokerBox.current?.detail || 'unknown'})`,
        };
      },
      reconcile: async () => {
        const again = await listCapitalOpenPositions(session);
        if (!again.ok) {
          return { found: false, detail: again.detail || 'reconcile list failed' };
        }
        const pos = matchOpenOnEpic(again.positions, s.epic);
        if (!pos) return { found: false, detail: 'no position at broker after timeout' };
        return {
          found: true,
          deal_id: pos.deal_id,
          direction: pos.direction,
          detail: `reconciled dealId=${pos.deal_id}`,
        };
      },
      confirm: async (_intent, _coid, dealRef) => {
        if (!dealRef) return { ok: false, status: 'UNKNOWN', detail: 'no dealRef' };
        const conf = await confirmCapitalDeal(session, dealRef);
        if (!conf.ok) {
          return { ok: false, status: 'UNKNOWN', detail: conf.detail };
        }
        if (conf.deal_id) {
          return {
            ok: true,
            status: 'ACCEPTED',
            deal_id: conf.deal_id,
            deal_reference: dealRef,
            detail: conf.detail,
          };
        }
        return { ok: false, status: 'PENDING', detail: conf.detail || 'confirm pending' };
      },
    }
  );

  if (exec.ok === false) {
    s.error = exec.reason;
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      code:
        exec.code === 'BROKER_RESULT_UNRESOLVED' || exec.code === 'NETWORK_TIMEOUT'
          ? DecisionCodes.BROKER_RESULT_UNRESOLVED
          : exec.code === 'BROKER_REJECTED'
            ? DecisionCodes.BROKER_REJECTED
            : DecisionCodes.BLOCKED_TECHNICAL,
      detail: `ORDER FAIL ${direction}: ${exec.reason}`,
    });
    return;
  }

  // HTTP OK / BROKER_ACCEPTED alone is not a fill — require POSITION_OPEN (confirm evidence).
  if (exec.code !== 'POSITION_OPEN') {
    s.last_deal_reference =
      exec.order.broker_deal_reference || brokerBox.current?.deal_reference || s.last_deal_reference;
    pushTick(s, {
      phase: 'INFO',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      code: DecisionCodes.ORDER_SUBMITTING,
      detail: `BROKER_ACCEPTED pending confirm · ${direction} · ${
        exec.order.broker_deal_reference || brokerBox.current?.deal_reference || 'no dealRef'
      } · do not claim position without deal evidence`,
    });
    return;
  }

  // Prefer broker-reported fields from successful submit / reconcile / confirm.
  let finalBroker: {
    ok: boolean;
    detail: string;
    deal_reference?: string;
    status: number;
    json: unknown;
  } | null = brokerBox.current;
  if ((!finalBroker || !finalBroker.ok) && exec.order.broker_deal_id) {
    finalBroker = {
      ok: true,
      detail: 'confirmed / reconciled after submit',
      deal_reference: exec.order.broker_deal_reference || undefined,
      status: 200,
      json: null,
    };
  }

  if (!finalBroker || !finalBroker.ok) {
    s.error = 'ORDER FAIL — no broker result after RISK_ACCEPTED path';
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      code: DecisionCodes.BROKER_REJECTED,
      detail: `ORDER FAIL ${direction}: no broker result after accepted execution`,
    });
    return;
  }

  s.orders_placed += 1;
  s.open_side = direction;
  s.mode = 'MANAGE';
  s.last_deal_reference = finalBroker.deal_reference || exec.order.broker_deal_reference || null;
  s.entry_price = mid;
  s.entry_at = new Date().toISOString();
  s.mfe = 0;
  s.mae = 0;
  s.peak_favorable = mid;
  s.peak_retention = null;
  s.unrealized = 0;
  s.safety_sl = stopLevel != null && Number.isFinite(stopLevel) ? stopLevel : null;
  s.error = null;

  const dealId =
    exec.order.broker_deal_id ||
    (await resolveDealId(session, s, finalBroker.deal_reference));
  if (dealId) s.deal_id = dealId;

  if (dealId) {
    try {
      const again = await listCapitalOpenPositions(session);
      const pos = again.ok ? matchOpenOnEpic(again.positions, s.epic) : null;
      if (pos?.stop_level != null && Number.isFinite(pos.stop_level)) {
        s.safety_sl = pos.stop_level;
      }
    } catch {
      /* ignore */
    }
  }

  pushTick(s, {
    phase: 'ORDER',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    code: DecisionCodes.FILLED,
    detail: `ORDER ENTRY ${direction} ${s.display_name} lot=${s.lot_size} · SL ${
      s.safety_sl ?? 'none'
    }${usedStopDistance != null ? ` (dist ${usedStopDistance}pts)` : ''} · ${finalBroker.detail}${
      dealId ? ` · dealId=${dealId}` : ''
    } · intent=${intentId}`,
  });
  if (s.client_id) {
    emitToClient(s.client_id, {
      type: 'trade_opened',
      robot_id: s.id,
      market: s.epic,
      display_name: s.display_name,
      side: direction,
      trade_type: mapTradeType(direction, setupType, s.regime),
      lot_size: s.lot_size,
      entry_price: s.entry_price,
    });
  }

  try {
    const m = await pool.query(
      `SELECT id FROM capital_markets
       WHERE broker_connection_id = $1 AND epic = $2 LIMIT 1`,
      [s.connection_id, s.epic]
    );
    await pool.query(
      `INSERT INTO positions
       (broker_account_id, instrument_id, direction, entry_price, quantity, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
      [
        s.account_id,
        m.rows[0]?.id || 0,
        direction === 'BUY' ? 'LONG' : 'SHORT',
        quote.mid || 0,
        s.lot_size,
      ]
    );
  } catch {
    /* Capital order already live */
  }
}


async function robotCycle(s: Internal) {
  if (!s.running) return;
  if (s.cycle_in_flight) return;
  s.cycle_in_flight = true;
  try {
    await robotCycleBody(s);
  } finally {
    s.cycle_in_flight = false;
  }
}

async function robotCycleBody(s: Internal) {
  if (!s.running) return;

  const { rows } = await pool.query(
    `SELECT bc.id, bc.environment, bc.identifier, bc.broker_name
     FROM broker_connections bc WHERE bc.id = $1`,
    [s.connection_id]
  );
  if (!rows.length) {
    pushTick(s, {
      phase: 'ERROR',
      bid: null,
      ask: null,
      mid: null,
      detail: 'Broker connection missing',
    });
    return;
  }
  const conn = rows[0] as { environment: string; identifier: string | null; broker_name: string };
  if (conn.broker_name !== 'capital_com') {
    pushTick(s, {
      phase: 'ERROR',
      bid: null,
      ask: null,
      mid: null,
      detail: 'Not Capital.com',
    });
    return;
  }

  const creds = await loadCreds(s.connection_id);
  const accRow = await pool.query(
    `SELECT external_account_id FROM broker_accounts WHERE id = $1`,
    [s.account_id]
  );
  const capitalAccountId =
    (accRow.rows[0]?.external_account_id as string | null | undefined) || null;

  const opened = await acquireCapitalSession({
    environment: conn.environment,
    apiKey: creds.api_key || '',
    identifier: (conn.identifier || '').trim(),
    password: creds.password || '',
    connectionId: s.connection_id,
    capitalAccountId,
  });
  if (opened.ok === false) {
    s.reads_fail += 1;
    s.error = opened.result.detail;
    const rateLimited =
      opened.result.status === 429 || /rate-limit|too-many|cooldown/i.test(opened.result.detail);
    pushTick(s, {
      phase: 'ERROR',
      bid: null,
      ask: null,
      mid: null,
      code: rateLimited ? DecisionCodes.RATE_LIMITED : DecisionCodes.ERROR_SESSION,
      detail: rateLimited
        ? `RATE LIMIT — ${opened.result.detail}`
        : `Session fail: ${opened.result.detail}`,
    });
    // Slow this robot while cooling down so control panel stays usable
    if (rateLimited) setRobotCadence(s, 20_000);
    return;
  }

  try {
    const quote = await fetchCapitalMarketQuote(opened.session, s.epic);
    if (!quote.raw_ok) {
      s.reads_fail += 1;
      s.error = quote.detail || 'No quote';
      pushTick(s, {
        phase: 'ERROR',
        bid: null,
        ask: null,
        mid: null,
        code: DecisionCodes.ERROR_NO_QUOTE,
        detail: quote.detail || `No quote for ${s.display_name} (${s.epic})`,
      });
      return;
    }

    s.reads_ok += 1;
    s.error = null;
    s.last_quote_at = new Date().toISOString();
    s.capital_market_status = quote.market_status;
    if (quote.epic && quote.epic !== s.epic) {
      s.epic = quote.epic;
    }

    // PRIMARY Capital quote → FeedManager (money-path authority)
    s.feedManager.ingest({
      source: 'capital',
      epic: s.epic,
      bid: quote.bid,
      ask: quote.ask,
      source_timestamp: s.last_quote_at,
    });

    // Multi-provider + LOCAL feed snapshot ALWAYS (even when market closed) —
    // otherwise closed epics stay stuck at 0/0 NONE on the board.
    if (Date.now() - s.last_multi_feed_ms >= 4_000) {
      s.last_multi_feed_ms = Date.now();
      try {
        s.multiFeed = await readMultiFeedPrice(s.epic, { anchorMid: quote.mid });
      } catch {
        /* keep previous */
      }
    }
    const pickedClosed = pickOhlcMid(quote.mid, s.multiFeed);
    s.feed_source = pickedClosed.source;
    s.feed_contributing = s.multiFeed?.contributing ?? 0;
    s.feed_sender_count = s.multiFeed?.sender_count ?? 0;
    s.feed_agreement = s.multiFeed?.agreement ?? null;
    // Local Capital quote alone is still a feed — never leave the board at 0/0 NONE.
    if (quote.mid != null && (s.feed_contributing || 0) < 1) {
      s.feed_source = 'LOCAL';
      s.feed_contributing = 1;
      s.feed_sender_count = Math.max(1, s.feed_sender_count || 0);
      s.feed_agreement = s.feed_agreement || 'INSUFFICIENT';
      s.feed_legs = [
        {
          sender_id: `local-${s.account_id}`,
          name: `${s.account_name || 'Capital'} LOCAL`,
          ok: true,
          mid: quote.mid,
          latency_ms: 0,
          detail: 'session quote (market may be closed)',
        },
        ...(s.multiFeed?.legs || []).filter((l) => l.sender_id !== `local-${s.account_id}`),
      ];
    } else {
      s.feed_legs = s.multiFeed?.legs ?? s.feed_legs ?? [];
    }

    // OHLC must update at most once per cycle. A second updateTenSecondOhlc in the
    // same 10s bucket clears just_closed → entry forever stuck on "wait bar close".
    const pushOhlcTick = (mid: number | null | undefined) => {
      if (mid == null || !Number.isFinite(mid)) return;
      s.ohlcState = updateTenSecondOhlc(s.ohlcState, mid, Date.now());
      s.ohlc_10s = publicOhlc10s(s.ohlcState);
      if (s.ohlcState.just_closed && s.ohlcState.last_closed) {
        applyRobotRegime(s, [s.ohlcState.last_closed]);
      }
    };

    // Capital marketStatus not TRADEABLE/OPEN → park (price can still stream when CLOSED)
    if (!marketAllowsTrading(quote.market_status)) {
      pushOhlcTick(pickedClosed.mid ?? quote.mid);
      setRobotCadence(s, CLOSED_MARKET_CADENCE_MS);
      const now = Date.now();
      if (now - s.last_market_closed_tick_ms >= CLOSED_MARKET_TICK_EVERY_MS) {
        s.last_market_closed_tick_ms = now;
        pushTick(s, {
          phase: 'SCAN',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          code: DecisionCodes.BLOCKED_TECHNICAL,
          detail: formatCapitalParkDetail(
            s.epic,
            quote.market_status,
            `feeds ${s.feed_contributing}/${s.feed_sender_count} ${s.feed_source} · poll ${
              CLOSED_MARKET_CADENCE_MS / 1000
            }s`,
          ),
        });
      }
      return;
    }

    // Restore normal cadence after a successful tradeable read (may have been slowed by 429 / closed)
    setRobotCadence(s, ACTIVE_CADENCE_MS);
    s.last_mid = quote.mid;

    const picked = pickOhlcMid(quote.mid, s.multiFeed);
    s.feed_source = picked.source;
    s.feed_contributing = Math.max(s.feed_contributing || 0, s.multiFeed?.contributing ?? 0);
    s.feed_sender_count = Math.max(s.feed_sender_count || 0, s.multiFeed?.sender_count ?? 0);
    s.feed_agreement = s.multiFeed?.agreement ?? s.feed_agreement ?? null;
    if (s.multiFeed?.legs?.length) s.feed_legs = s.multiFeed.legs;

    // Single OHLC tick for this cycle (Capital-safe mid)
    pushOhlcTick(picked.mid ?? quote.mid);

    // Sync truth from broker — source of ONE TRADE ONLY
    const listed = await listCapitalOpenPositions(opened.session);
    let brokerOpen: CapitalOpenPosition | null = null;
    if (listed.ok) {
      brokerOpen = matchOpenOnEpic(listed.positions, s.epic);
      if (brokerOpen) {
        s.open_side = brokerOpen.direction;
        s.deal_id = brokerOpen.deal_id;
        if (s.entry_price == null) s.entry_price = brokerOpen.open_level ?? quote.mid;
        if (!s.entry_at) s.entry_at = new Date().toISOString();
        s.mode = 'MANAGE';
        if (brokerOpen.upl != null) s.unrealized = brokerOpen.upl;
      } else if (s.open_side) {
        // Local thought open but broker flat → treat as closed
        pushTick(s, {
          phase: 'INFO',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: 'Broker flat on this epic — trade closed externally · FLAT (entry allowed)',
        });
        s.closed_at_ms = Date.now();
        clearTradeState(s);
      }
    } else {
      pushTick(s, {
        phase: 'ERROR',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        code: DecisionCodes.BLOCKED_TECHNICAL,
        detail: `BLOCKED_TECHNICAL · Position sync warn: ${listed.detail} · holding no-new-entry while unsure`,
      });
      return;
    }

    if (quote.mid != null && s.open_side && s.entry_price != null) {
      updateExcursion(s, quote.mid);
    }

    pushTick(s, {
      phase: 'READ',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `READ ${s.display_name} · bid=${quote.bid} ask=${quote.ask} mid=${quote.mid} · mode=${s.mode} · side=${
        s.open_side || 'FLAT'
      } · UPL=${s.unrealized != null ? s.unrealized.toFixed(5) : '—'} · MFE=${s.mfe.toFixed(5)}`,
    });

    // ——— MANAGE open trade even if new entries are OFF ———
    if (s.open_side || brokerOpen) {
      s.mode = 'MANAGE';
      if (quote.mid == null) return;

      // One-shot: pull already-open SL in to 0.20% of price
      if (!s.sl_tighten_done && s.deal_id && s.open_side && quote.mid != null) {
        s.sl_tighten_done = true;
        const tighter = safetyStopLevel(
          s.open_side,
          quote.mid,
          quote.bid ?? null,
          quote.ask ?? null,
          quote.spread ?? null,
          quote.min_stop_distance ?? null,
          1
        );
        const cur = s.safety_sl;
        const px = quote.mid;
        const canTighten =
          cur != null &&
          Number.isFinite(cur) &&
          ((s.open_side === 'BUY' && tighter > cur && tighter < px) ||
            (s.open_side === 'SELL' && tighter < cur && tighter > px));
        if (canTighten) {
          const upd = await updateCapitalStop(opened.session, s.deal_id, tighter);
          if (upd.ok) {
            s.safety_sl = tighter;
            pushTick(s, {
              phase: 'INFO',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: `SL tightened ${cur} → ${tighter} (0.20% of price)`,
            });
          } else {
            pushTick(s, {
              phase: 'INFO',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: `SL tighten skipped: ${upd.detail}`,
            });
          }
        }
      }

      const decision = decideBestOutcomeExit(s, quote.mid);
      if (decision.exit) {
        await exitTrade(opened.session, s, quote, decision.reason);
        return;
      }

      pushTick(s, {
        phase: 'MANAGE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `ONE TRADE · manage ${s.open_side} · ${s.regime} · UPL ${
          s.unrealized != null ? s.unrealized.toFixed(5) : '—'
        } · MFE ${s.mfe.toFixed(5)} · MAE ${s.mae.toFixed(5)} · ret ${
          s.peak_retention != null ? `${(s.peak_retention * 100).toFixed(0)}%` : '—'
        } · no new orders`,
      });
      return;
    }

    if (!s.trading_enabled) {
      pushTick(s, {
        phase: 'SCAN',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        code: DecisionCodes.BLOCKED_TECHNICAL,
        detail: 'BLOCKED_TECHNICAL · Trading OFF — reading only (open trades still managed above)',
      });
      return;
    }

    // ——— FLAT: entry only after close (and only if entry_enabled) ———
    if (!s.entry_enabled) {
      s.mode = s.open_side ? 'MANAGE' : 'FLAT';
      pushTick(s, {
        phase: 'SCAN',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        code: DecisionCodes.BLOCKED_TECHNICAL,
        detail:
          'BLOCKED_TECHNICAL · MANAGE-ONLY · waiting for central pipeline intent (no local BUY/SELL brain)',
      });
      return;
    }

    s.mode = 'ENTRY';
    // No artificial post-close cooldown — proven strategy reacts on the next valid setup.

    if (quote.mid == null) return;

    // Seed from this account's SECOND candles only when multi-provider OHLC is NOT in charge.
    // Otherwise a single Capital row would overwrite consensus bars used for regime/entry.
    if (!multiFeedOwnsOhlc(s.multiFeed) && Date.now() - s.last_second_fetch_ms >= 8_000) {
      s.last_second_fetch_ms = Date.now();
      const sec = await fetchCapitalPrices(opened.session, s.epic, 'SECOND', 180);
      if (sec.ok && sec.candles.length >= 10) {
        const bars = aggregateSecondsToTen(sec.candles);
        const last = bars[bars.length - 1];
        if (last) {
          const key = `${last.open.toFixed(4)}:${last.close.toFixed(4)}:${last.high.toFixed(4)}`;
          const isNew = key !== s.last_closed_bar_key;
          s.ohlcState = {
            forming: s.ohlcState.forming,
            last_closed: last,
            just_closed: isNew,
          };
          if (isNew) s.last_closed_bar_key = key;
          s.ohlc_10s = publicOhlc10s(s.ohlcState);
          applyRobotRegime(s, bars);
        }
      }
    }

    // PRIMARY feed gate — REFERENCE never authorizes execution alone
    const feedGate = allowEntryFromPrimaryFeed(s.feedManager, s.epic);
    if (!feedGate.ok) {
      pushTick(s, {
        phase: 'ERROR',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        code: DecisionCodes.BLOCKED_TECHNICAL,
        detail: `BLOCKED_TECHNICAL · ${feedGate.reason}`,
      });
      return;
    }

    const bar = s.ohlcState.last_closed;
    const ohlc = s.ohlc_10s;
    if (Date.now() - s.last_minute_fetch_ms >= 30_000) {
      s.last_minute_fetch_ms = Date.now();
      try {
        const hist = await fetchCapitalMinutePrices(opened.session, s.epic, 3);
        if (hist.ok) s.minuteCandles = hist.candles;
      } catch {
        /* keep previous 1m snapshot */
      }
    }
    const bias = resolveTrendBias(s.closedBars, s.minuteCandles);
    s.trend_bias = effectiveBias(s.regime, bias, bar);
    applyBiasRegimeUnlock(s);
    const regimeLabel = effectiveRegimeName(s);
    const ohlcLine = bar
      ? `10s O=${bar.open.toFixed(2)} H=${bar.high.toFixed(2)} L=${bar.low.toFixed(2)} C=${bar.close.toFixed(2)} ${regimeLabel} · bias ${s.trend_bias} · feeds ${
          s.feed_contributing || 0
        }/${s.feed_sender_count || 0} ${s.feed_source || 'LOCAL'} ${s.feed_agreement || ''}`
      : `10s OHLC seeding · feeds ${s.feed_contributing || 0}/${s.feed_sender_count || 0}`;

    const primarySnap = s.feedManager.snapshot(s.epic);
    const decision = evaluateStrategy({
      epic: s.epic,
      market_snapshot_id: `desk_${s.id}_${s.last_quote_at || Date.now()}`,
      market_open: marketAllowsTrading(quote.market_status),
      feed_fresh: primarySnap.primary_status === 'LIVE' && primarySnap.allows_execution,
      bar_closed: !!(s.ohlcState.just_closed && bar),
      closed_bar: bar || null,
      bars: s.closedBars,
      regime: s.regime,
      minute_candles: s.minuteCandles,
      trading_enabled: s.trading_enabled && s.entry_enabled,
      manage_only: !s.entry_enabled,
    });

    let direction: 'BUY' | 'SELL' | null = null;
    let reason = '';
    let setupType: string | null = null;

    if (decision.code === 'NO_SETUP') {
      pushTick(s, {
        phase: 'SCAN',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        code: DecisionCodes.NO_SETUP,
        detail: `${ohlcLine} · ${decision.reason}${
          !bar || !s.ohlcState.just_closed
            ? ` · forming C=${ohlc.forming_c != null ? ohlc.forming_c.toFixed(2) : '—'}`
            : ''
        }`,
      });
      return;
    }

    if (decision.code === 'BLOCKED_TECHNICAL') {
      pushTick(s, {
        phase: 'ERROR',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        code: DecisionCodes.BLOCKED_TECHNICAL,
        detail: `BLOCKED_TECHNICAL · ${decision.block_reason || decision.reason}`,
      });
      return;
    }

    if (decision.code === 'ENTER_LONG' || decision.code === 'ENTER_SHORT') {
      direction = decision.direction;
      setupType = decision.setup;
      reason = decision.reason;
      s.trend_bias = decision.bias;
      pushTick(s, {
        phase: 'DECIDE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        code: strategyToDecisionCode(decision),
        detail: `${ohlcLine} · ${decision.code} · ${reason}`,
      });
    }

    // Late-move / setup invalidation is owned solely by evaluateStrategy (minute_candles).
    // Desk must not apply a second market-analysis Strategy gate after ENTER_*.

    // Capital button lag vs already-printed drop/rally (chart / near Capital refs / 10s OHLC).
    // Distant public spot (Yahoo/Aurum basis) is filtered inside detectStaleQuoteAdverse.
    if (direction && quote.mid != null) {
      const capitalPeerMids = (s.multiFeed?.legs || [])
        .filter((l) => l.ok && l.mid != null && Number.isFinite(l.mid))
        .filter((l) => /capital\.com|capital_com/i.test(`${l.name} ${l.sender_id} ${l.detail || ''}`))
        .map((l) => ({ name: l.name, mid: l.mid as number }));
      const publicNear = (s.multiFeed?.legs || [])
        .filter((l) => l.ok && l.mid != null && Number.isFinite(l.mid))
        .filter((l) => !String(l.detail || '').includes('FAR from Capital'))
        .filter((l) => !/capital\.com|capital_com/i.test(`${l.name} ${l.sender_id}`))
        .map((l) => ({ name: l.name, mid: l.mid as number }));
      const refs = buildFresherRefs({
        publicNearMids: [...capitalPeerMids, ...publicNear],
        ohlcClose: s.ohlcState.last_closed?.close ?? s.ohlc_10s?.last_c ?? null,
        formingClose: s.ohlcState.forming?.close ?? s.ohlc_10s?.forming_c ?? null,
      });
      const lag = detectStaleQuoteAdverse(direction, quote.mid, refs);
      if (lag.block) {
        pushTick(s, {
          phase: 'ERROR',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          code: DecisionCodes.BLOCKED_TECHNICAL,
          detail: `BLOCKED_TECHNICAL · ${lag.reason}`,
        });
        direction = null;
      }
    }

    if (!direction) return;
    await enterTrade(opened.session, s, direction, quote, reason, setupType);
  } catch (err) {
    s.reads_fail += 1;
    const detail = err instanceof Error ? err.message : String(err);
    s.error = detail;
    pushTick(s, { phase: 'ERROR', bid: null, ask: null, mid: null, detail });
  }
  // Do NOT close pooled Capital session each tick — that caused HTTP 429 login spam
}

export async function startRobotSession(input: {
  account_id: number;
  epic: string;
  display_name?: string;
  lot_size: number;
  trading_enabled?: boolean;
  /** Default true for Admin Robot Board; Client Panel manage-only uses false */
  entry_enabled?: boolean;
}): Promise<RobotSession> {
  const { rows } = await pool.query(
    `SELECT ba.id, ba.display_name, ba.external_account_id,
            bc.id as connection_id, bc.environment, bc.broker_name,
            c.id as client_id, c.name as client_name
     FROM broker_accounts ba
     JOIN broker_connections bc ON bc.id = ba.broker_connection_id
     JOIN clients c ON c.id = bc.client_id
     WHERE ba.id = $1`,
    [input.account_id]
  );
  if (!rows.length) throw new Error('Trading account not found');
  const acc = rows[0] as {
    id: number;
    display_name: string;
    connection_id: number;
    environment: string;
    broker_name: string;
    client_id: number;
    client_name: string;
  };
  if (acc.broker_name !== 'capital_com') throw new Error('Only Capital.com accounts supported');

  let displayName = (input.display_name || '').trim();
  let epic = input.epic.trim();
  if (!epic) throw new Error('epic required');

  const exact = await pool.query(
    `SELECT epic, display_name FROM capital_markets
     WHERE broker_connection_id = $1 AND epic = $2
     ORDER BY updated_at DESC LIMIT 1`,
    [acc.connection_id, epic]
  );
  if (exact.rows.length) {
    epic = exact.rows[0].epic as string;
    displayName = (exact.rows[0].display_name as string) || displayName || epic;
  } else {
    const byName = await pool.query(
      `SELECT epic, display_name FROM capital_markets
       WHERE broker_connection_id = $1 AND display_name ILIKE $2
       ORDER BY updated_at DESC LIMIT 1`,
      [acc.connection_id, epic]
    );
    if (byName.rows.length) {
      epic = byName.rows[0].epic as string;
      displayName = (byName.rows[0].display_name as string) || displayName || epic;
    }
  }
  if (!displayName) displayName = epic;

  const lot = Number(input.lot_size);
  if (!Number.isFinite(lot) || lot <= 0) throw new Error('lot_size must be > 0');

  const id = robotIdFor(acc.id, epic);
  const existing = sessions.get(id);
  if (existing?.running) {
    await stopRobotSession(id);
  }
  sessions.delete(id);

  const session: Internal = {
    id,
    account_id: acc.id,
    client_id: acc.client_id,
    account_name: acc.display_name,
    client_name: acc.client_name || acc.display_name,
    environment: acc.environment,
    connection_id: acc.connection_id,
    epic,
    display_name: displayName,
    lot_size: lot,
    running: true,
    trading_enabled: input.trading_enabled !== false,
    started_at: new Date().toISOString(),
    stopped_at: null,
    ticks: [],
    last_quote_at: null,
    last_mid: null,
    capital_market_status: null,
    last_deal_reference: null,
    deal_id: null,
    entry_price: null,
    entry_at: null,
    mfe: 0,
    mae: 0,
    peak_retention: null,
    unrealized: null,
    mode: 'FLAT',
    orders_placed: 0,
    exits_done: 0,
    reads_ok: 0,
    reads_fail: 0,
    open_side: null,
    safety_sl: null,
    error: null,
    entry_enabled: input.entry_enabled !== false,
    timer: null,
    closed_at_ms: 0,
    peak_favorable: 0,
    last_market_closed_tick_ms: 0,
    cadence_ms: 0,
    ohlcState: emptyTenSecState(),
    last_second_fetch_ms: 0,
    last_closed_bar_key: '',
    closedBars: [],
    last_minute_fetch_ms: 0,
    minuteCandles: [],
    last_multi_feed_ms: 0,
    multiFeed: null,
    sl_tighten_done: false,
    cycle_in_flight: false,
    feedManager: (() => {
      const fm = new FeedManager();
      fm.defineSource('capital', 'PRIMARY');
      return fm;
    })(),
    feed_source: 'NONE',
    feed_contributing: 0,
    feed_sender_count: 0,
    feed_agreement: null,
    regime: 'UNKNOWN',
    trend_bias: 'FLAT',
    ohlc_10s: publicOhlc10s(emptyTenSecState()),
  };

  if (session.entry_enabled && acc.client_id) {
    const reg = getClientTradingRegistry();
    reg.ensure(acc.client_id, acc.id);
    reg.start(acc.client_id, acc.id);
  }

  const others = [...sessions.values()].filter((x) => x.running && x.id !== id).length;
  pushTick(session, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: null,
    detail: `ROBOT START · BUILD ${runtimeBuildInfo().git_sha} · NODE BRAIN · id=${id} · ${displayName} (${epic}) · lot ${lot} · ${acc.environment.toUpperCase()} · 10s OHLC from multi-feed consensus · ONE TRADE ONLY · other robots: ${others}`,
  });
  pushTick(session, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: null,
    detail:
      'Rules: Node robotDesk (not C++ market-core) · SL = 0.20% of price · 3-min trend · with-trend or confirmed fade after large move · max 1 open',
  });

  sessions.set(id, session);
  emitToClient(acc.client_id, {
    type: 'robot_started',
    robot_id: id,
    market: epic,
    display_name: displayName,
    lot_size: lot,
    robot_status: 'RUNNING',
  });
  void robotCycle(session);
  // 6s when TRADEABLE; auto-slows to 90s when market closed
  setRobotCadence(session, ACTIVE_CADENCE_MS);

  return publicSession(session);
}


/** Attach manage-only session after pipeline/broker-confirmed fill (no entry brain). */
export async function attachManageOnlyRobot(input: {
  account_id: number;
  epic: string;
  display_name: string;
  lot_size: number;
  side: 'BUY' | 'SELL';
  entry_price: number | null;
  deal_reference?: string | null;
  regime?: string | null;
  setup_type?: string | null;
}): Promise<RobotSession> {
  const id = robotIdFor(input.account_id, input.epic);
  const existing = sessions.get(id);
  if (existing?.running) {
    existing.entry_enabled = false;
    existing.trading_enabled = true;
    existing.open_side = input.side;
    existing.mode = 'MANAGE';
    if (existing.entry_price == null) existing.entry_price = input.entry_price;
    if (!existing.entry_at) existing.entry_at = new Date().toISOString();
    if (input.deal_reference) existing.last_deal_reference = input.deal_reference;
    if (input.regime) existing.regime = normalizeRegime(input.regime);
    existing.orders_placed = Math.max(existing.orders_placed, 1);
    pushTick(existing, {
      phase: 'ORDER',
      bid: null,
      ask: null,
      mid: input.entry_price,
      detail: `PIPELINE FILL ${input.side} ${input.display_name} lot=${input.lot_size} · ${
        existing.regime
      } · manage-only (kept MFE ${existing.mfe.toFixed(5)})`,
    });
    return publicSession(existing);
  }

  const session = await startRobotSession({
    account_id: input.account_id,
    epic: input.epic,
    display_name: input.display_name,
    lot_size: input.lot_size,
    trading_enabled: true,
    entry_enabled: false,
  });
  const internal = sessions.get(session.id);
  if (internal) {
    internal.open_side = input.side;
    internal.entry_price = input.entry_price;
    internal.entry_at = new Date().toISOString();
    internal.mode = 'MANAGE';
    internal.last_deal_reference = input.deal_reference || null;
    internal.orders_placed = Math.max(internal.orders_placed, 1);
    if (input.regime) internal.regime = normalizeRegime(input.regime);
    pushTick(internal, {
      phase: 'ORDER',
      bid: null,
      ask: null,
      mid: input.entry_price,
      detail: `PIPELINE FILL ${input.side} ${input.display_name} lot=${input.lot_size} · ${
        internal.regime
      } · manage-only attached`,
    });
  }
  return getRobotSession(session.id) || session;
}

/** Toggle trading/entry flags on matching running robots (account-scoped when provided). */
export function setRobotsTradingEnabled(
  clientId: number,
  accountId: number | null | undefined,
  enabled: boolean
): number {
  let n = 0;
  for (const s of sessions.values()) {
    if (!s.running || s.client_id !== clientId) continue;
    if (accountId != null && s.account_id !== accountId) continue;
    s.trading_enabled = enabled;
    s.entry_enabled = enabled;
    n += 1;
  }
  const reg = getClientTradingRegistry();
  if (enabled) reg.start(clientId, accountId ?? null);
  else reg.stop(clientId, accountId ?? null);
  return n;
}
