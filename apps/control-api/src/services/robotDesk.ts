import { pool } from '../db/pool.js';
import { decrypt } from '../security/encryption.js';
import {
  withCapitalAccountSession,
  closeCapitalPosition,
  confirmCapitalDeal,
  createCapitalPosition,
  fetchCapitalMarketQuote,
  fetchCapitalMinutePrices,
  fetchCapitalPrices,
  listCapitalOpenPositions,
  type CapitalMarketQuote,
  type CapitalOpenPosition,
  type CapitalPriceCandle,
  type CapitalSession,
} from './capitalCom.js';
import { emitToClient } from './clientEvents.js';
import { mapTradeType } from './tradePresentation.js';
import {
  observeClosedBars,
  normalizeRegime,
  REGIME_NAMES,
  MIN_BARS_FOR_ZONE,
  clearRegimeBookFor,
  type RegimeName,
} from './regimes.js';
import {
  closed1mProfitPolicy,
  decideBestOutcomeExit,
  favorableMove,
} from './exitManage.js';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import { regimeAllowedForEntry } from './deskCalibration.js';
import {
  flipFilterReason,
  requiredFlipSide,
  sameDirLockLeftSec,
  sameDirectionBlocked,
} from './flipFilter.js';
import { buildEntryWatch, type EntryWatch } from './entryWatch.js';
import {
  allowEntryFromFeeds,
  pickOhlcMid,
  readMultiFeedPrice,
  type MultiFeedPrice,
  type MultiFeedLeg,
} from './robotReader.js';
import {
  bodyPct,
  emptyTenSecState,
  enrichOhlcWithSecondCandles,
  expandMinutesToTen,
  publicOhlc10s,
  rangePct,
  updateTenSecondOhlc,
  type TenSecBar,
  type TenSecState,
} from './tenSecondOhlc.js';
import { withEpicEntryLock } from './epicEntryLock.js';

export type RobotTick = {
  at: string;
  phase: 'READ' | 'DECIDE' | 'ORDER' | 'WAIT' | 'ERROR' | 'INFO' | 'MANAGE' | 'EXIT';
  bid: number | null;
  ask: number | null;
  mid: number | null;
  detail: string;
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
  last_bid: number | null;
  last_ask: number | null;
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
  orders_placed: number;
  exits_done: number;
  reads_ok: number;
  reads_fail: number;
  open_side: 'BUY' | 'SELL' | null;
  /** Last closed trade side — same direction blocked for 3 min after close */
  last_closed_side: 'BUY' | 'SELL' | null;
  /** Epoch ms of last close — fanout + Admin share the 3m flip lock */
  closed_at_ms: number;
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
    forming_body_pct: number | null;
    forming_range_pct: number | null;
    body_pct: number | null;
    range_pct: number | null;
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
  /** Live: what robot reads / waits for before entry (all regimes) */
  entry_watch?: EntryWatch | null;
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
  /** Throttle Capital SECOND → 10s OHLC enrich (anti flat-bar) */
  last_second_ohlc_ms: number;
  last_closed_bar_key: string;
  closedBars: TenSecBar[];
  last_multi_feed_ms: number;
  multiFeed: MultiFeedPrice | null;
  /** Capital MINUTE candles while managing (for 1m continue/reverse) */
  last_minute_candles: CapitalPriceCandle[];
  last_manage_minute_fetch_ms: number;
  /** After reverse Capital 1m: PeakProtect 25% giveback trails live */
  peak_protect_armed: boolean;
  /** Last Capital 1m close key already evaluated for profit policy */
  last_1m_profit_exit_key: string;
  /** Cached live entry watch for board UI */
  entry_watch: EntryWatch | null;
  /** Consecutive EXIT blocked (no dealId) — clear ghost after broker flat */
  exit_deal_fails: number;
  /** Prevent overlapping robotCycle (Capital awaits > cadence) */
  cycle_busy: boolean;
  /** Wall clock when cycle_busy became true — unstick hung Capital awaits */
  cycle_busy_since: number;
  /** Retry entry after failed order on same closed 10s bar */
  pending_entry: {
    direction: 'BUY' | 'SELL';
    reason: string;
    setup: string | null;
    bar_key: string;
  } | null;
  /**
   * Soft HardInv first saw breach (ms) — confirm debounce vs wick “magic minus”.
   */
  hardinv_breach_since_ms: number;
  /**
   * Live 10s close waiting for entry decide.
   * Survives zone-seed / position-list races that clear just_closed before ORDER.
   */
  entry_close_latch: TenSecBar | null;
};

const ACTIVE_CADENCE_MS = 1_250;
/** How often to pull Capital SECOND candles to rebuild flat 10s bars */
const SECOND_OHLC_ENRICH_MS = 8_000;
const CLOSED_MARKET_CADENCE_MS = 90_000;
const CLOSED_MARKET_TICK_EVERY_MS = 5 * 60_000;
/** If a Capital await hangs, force-clear so the robot keeps polling */
const CYCLE_BUSY_STALE_MS = 50_000;
const ZONE_SEED_THROTTLE_MS = 15_000;

function marketAllowsTrading(status: string | null | undefined): boolean {
  const s = String(status || '')
    .trim()
    .toUpperCase();
  // Missing status → do not park (Capital sometimes omits it)
  if (!s) return true;
  return s === 'TRADEABLE' || s === 'OPEN';
}

function setRobotCadence(s: Internal, ms: number) {
  if (s.timer && s.cadence_ms === ms) return;
  if (s.timer) clearInterval(s.timer);
  s.cadence_ms = ms;
  s.timer = setInterval(() => {
    if (s.cycle_busy) {
      if (s.cycle_busy_since > 0 && Date.now() - s.cycle_busy_since > CYCLE_BUSY_STALE_MS) {
        s.cycle_busy = false;
        s.cycle_busy_since = 0;
        pushTick(s, {
          phase: 'ERROR',
          bid: null,
          ask: null,
          mid: null,
          detail: `CYCLE UNSTUCK — previous tick hung >${CYCLE_BUSY_STALE_MS / 1000}s (Capital await)`,
        });
      } else {
        return;
      }
    }
    void robotCycle(s);
  }, ms);
}

function isFlatTenBar(bar: TenSecBar | null | undefined): boolean {
  if (!bar) return true;
  return (
    (Math.abs(bodyPct(bar)) < 1e-12 && rangePct(bar) < 1e-12) || bar.ticks <= 2
  );
}

/** Whether to attempt Capital MINUTE→10s zone seed (multi-feed never fills history). */
export function shouldAttemptZoneSeed(
  closedBarCount: number,
  lastSeedAttemptMs: number,
  nowMs = Date.now(),
  throttleMs = ZONE_SEED_THROTTLE_MS
): boolean {
  if (closedBarCount >= MIN_BARS_FOR_ZONE) return false;
  return nowMs - lastSeedAttemptMs >= throttleMs;
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
  s.ticks.unshift({ ...tick, at: new Date().toISOString() });
  if (s.ticks.length > MAX_TICKS) s.ticks.length = MAX_TICKS;
}

function refreshEntryWatch(
  s: Internal,
  opts?: { cooldown_left_s?: number; status_override?: EntryWatch['status'] | null; last_reason?: string }
): void {
  const ohlc = publicOhlc10s(s.ohlcState);
  s.entry_watch = buildEntryWatch({
    running: s.running,
    open_side: s.open_side,
    entry_enabled: s.entry_enabled,
    regime: s.regime,
    last_closed: s.ohlcState.last_closed,
    forming_c: ohlc.forming_c,
    just_closed: Boolean(s.ohlcState.just_closed),
    closed_bar_count: s.closedBars.length,
    last_closed_side: s.last_closed_side,
    closed_at_ms: s.closed_at_ms,
    cooldown_left_s: opts?.cooldown_left_s,
    status_override: opts?.status_override,
    last_reason: opts?.last_reason,
  });
}

function publicSession(s: Internal): RobotSession {
  const {
    timer: _t,
    connection_id: _c,
    peak_favorable: _peak,
    last_market_closed_tick_ms: _lmc,
    cadence_ms: _cad,
    ohlcState: _ohlc,
    last_second_fetch_ms: _sec,
    last_second_ohlc_ms: _secOhlc,
    last_closed_bar_key: _bar,
    closedBars: _bars,
    last_multi_feed_ms: _mf,
    multiFeed: _multi,
    last_minute_candles: _mins,
    last_manage_minute_fetch_ms: _mmf,
    peak_protect_armed: _ppa,
    last_1m_profit_exit_key: _1m,
    exit_deal_fails: _edf,
    cycle_busy: _busy,
    cycle_busy_since: _busySince,
    pending_entry: _pend,
    ...rest
  } = s;
  if (!rest.entry_watch) refreshEntryWatch(s);
  return {
    ...rest,
    closed_at_ms: s.closed_at_ms,
    entry_watch: s.entry_watch,
    ohlc_10s: publicOhlc10s(s.ohlcState),
    feed_source: rest.feed_source,
    feed_contributing: s.multiFeed?.contributing ?? rest.feed_contributing ?? 0,
    feed_sender_count: s.multiFeed?.sender_count ?? rest.feed_sender_count ?? 0,
    feed_agreement: s.multiFeed?.agreement ?? rest.feed_agreement ?? null,
    feed_legs: s.multiFeed?.legs ?? rest.feed_legs ?? [],
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
  const w = s.entry_watch;
  let action = 'WAIT';
  if (!s.running) action = 'STOPPED';
  else if (s.open_side) action = `MANAGE ${s.open_side}`;
  else if (w?.status === 'ARMED') action = `ARMED ${w.direction || ''}`.trim();
  else if (w?.status === 'FLIP_FILTER')
    action = `FLIP LOCK · need ${w.need_side || 'opp'} · ${w.lock_left_s ?? 0}s (last ${w.last_closed_side || '—'})`;
  else if (w?.status === 'COOLDOWN') action = `COOLDOWN ${w.last_reason || ''}`.trim();
  else if (w?.status === 'MANAGE_ONLY') action = 'MANAGE-ONLY';
  else if (w?.status === 'SEEDING')
    action = w.zone_ready
      ? 'SEEDING'
      : `SEEDING · ${w.zone_bars}/${w.zone_need} · vēl ${w.zone_left}`;
  else if (w?.status === 'FORMING') action = 'WATCH · forming 10s';
  else if (w?.status === 'WAITING_TRIGGER') action = 'WATCH · trigger';
  else if (w?.status === 'REGIME_OFF') action = 'REGIME OFF';
  else if (s.mode === 'ENTRY') action = 'SCAN ENTRY';
  return {
    feeds,
    ohlc: ohlcLine,
    regime: s.regime || 'UNKNOWN',
    setup: w?.setup ?? null,
    action,
  };
}

export function robotBoardMeta(sessions: RobotSession[]) {
  const activeRegimes = [
    ...new Set(sessions.filter((s) => s.running).map((s) => s.regime || 'UNKNOWN')),
  ];
  const maxFeeds = sessions.reduce(
    (n, s) => Math.max(n, s.feed_sender_count || 0, s.feed_legs?.length || 0),
    0
  );
  const contributing = sessions.reduce((n, s) => Math.max(n, s.feed_contributing || 0), 0);
  return {
    regimes: [...REGIME_NAMES],
    trade_types: ['BUY LONG', 'SELL LONG', 'BUY SCALP', 'SELL SCALP'],
    active_regimes: activeRegimes,
    feed_sender_count: maxFeeds,
    feed_contributing: contributing,
    chain:
      'Capital OHLC → REGIME → ENTRY · EXIT: HardInv live · profit HOLD on 1m continue · reverse→PeakProtect 25% giveback',
    note:
      'Public feeds confirm near Capital CFD mid; no late-1m / stale-quote entry blocks. Peak giveback 25% all scalps.',
  };
}

function applyRobotRegime(s: Internal, bars?: TenSecBar[]) {
  const incoming = bars?.length
    ? bars
    : s.ohlcState.last_closed
      ? [s.ohlcState.last_closed]
      : [];
  // Never no-op on empty filter — still refresh from tick last_closed if present
  const feed =
    incoming.length > 0
      ? incoming
      : s.ohlcState.last_closed
        ? [s.ohlcState.last_closed]
        : [];
  if (!feed.length) return;

  // Local closed-bar history — never shared across accounts
  for (const bar of feed) {
    if (!bar || !Number.isFinite(bar.close)) continue;
    const last = s.closedBars[s.closedBars.length - 1];
    // Time-bucket dedupe — MINUTE→10s seed repeats OHLC 6×; those must all count
    if (last && last.open_time_ms === bar.open_time_ms) continue;
    s.closedBars.push(bar);
  }
  if (s.closedBars.length > 216) s.closedBars.splice(0, s.closedBars.length - 216);

  // Single path: zone + dwell/confirm stabilize via account-scoped book
  const snap = observeClosedBars(s.epic, feed, s.display_name, s.account_id);
  s.regime = snap.current;
}

/**
 * Fill thin 30m zone from Capital MINUTE history.
 * Multi-feed only supplies live mids — never block seed on multiFeedOwnsOhlc.
 * If a few live 10s bars arrived first, replace them with the richer seed (clear regime book).
 */
async function seedZoneFromMinuteHistory(
  session: CapitalSession,
  s: Internal,
  quote: { bid: number | null; ask: number | null; mid: number | null }
): Promise<void> {
  // Never steal the only entry window — zone seed used to force just_closed=false
  // on the close tick (regression of the SECOND-seed race fix).
  if (s.ohlcState.just_closed) return;
  if (!shouldAttemptZoneSeed(s.closedBars.length, s.last_second_fetch_ms)) return;
  s.last_second_fetch_ms = Date.now();
  const mins = await fetchCapitalPrices(session, s.epic, 'MINUTE', 40);
  if (!mins.ok || mins.candles.length < 2) {
    pushTick(s, {
      phase: 'WAIT',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `ZONE SEED WAIT · book=${s.closedBars.length}/${MIN_BARS_FOR_ZONE} · ${
        mins.detail || 'no minute candles'
      } · live 10s still building`,
    });
    refreshEntryWatch(s, {
      status_override: 'SEEDING',
      last_reason: `Lasa tirgu · ${s.closedBars.length}/${MIN_BARS_FOR_ZONE} · seed: ${mins.detail || 'fail'}`,
    });
    return;
  }
  const bars = expandMinutesToTen(mins.candles);
  if (bars.length <= s.closedBars.length) {
    pushTick(s, {
      phase: 'INFO',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `ZONE SEED skip · seed ${bars.length} ≤ book ${s.closedBars.length}`,
    });
    return;
  }
  // Replace thin live book so minute history is not appended after newer 10s bars
  clearRegimeBookFor(s.epic, s.account_id);
  s.closedBars = [];
  applyRobotRegime(s, bars);
  const last = bars[bars.length - 1];
  if (last) {
    s.ohlcState = {
      forming: s.ohlcState.forming,
      last_closed: last,
      just_closed: false,
    };
    s.last_closed_bar_key = closedBarKey(last);
    s.ohlc_10s = publicOhlc10s(s.ohlcState);
  }
  refreshEntryWatch(s, {
    last_reason: `ZONE SEED · ${s.closedBars.length}/${MIN_BARS_FOR_ZONE} sveces · regime=${s.regime}`,
  });
  pushTick(s, {
    phase: 'INFO',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: `ZONE SEED · ${mins.candles.length}m → ${bars.length}×10s · book=${s.closedBars.length} · regime=${s.regime}`,
  });
}

/** Last fully closed Capital 1m (not the forming minute). */
function lastClosedCapitalMinute(
  candles: CapitalPriceCandle[]
): CapitalPriceCandle | null {
  if (candles.length >= 2) return candles[candles.length - 2]!;
  return null;
}

/** Closed Capital 1m immediately before lastClosedCapitalMinute. */
function prevClosedCapitalMinute(
  candles: CapitalPriceCandle[]
): CapitalPriceCandle | null {
  if (candles.length >= 3) return candles[candles.length - 3]!;
  return null;
}

function capitalMinuteCandleKey(c: CapitalPriceCandle, prev: CapitalPriceCandle | null = null): string {
  // Prefer Capital snapshot time — never wall-clock (that re-armed Peak on stale close)
  const t =
    c.snapshot_time_ms != null && Number.isFinite(c.snapshot_time_ms)
      ? String(c.snapshot_time_ms)
      : `ohlc:${c.open.toFixed(4)}:${c.high.toFixed(4)}:${c.low.toFixed(4)}:${c.close.toFixed(4)}`;
  const p =
    prev != null
      ? `${prev.open.toFixed(4)}:${prev.close.toFixed(4)}`
      : 'noprev';
  return `${t}|${p}`;
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
  s.peak_protect_armed = false;
  s.last_1m_profit_exit_key = '';
  s.exit_deal_fails = 0;
  s.hardinv_breach_since_ms = 0;
}

function closedBarKey(bar: TenSecBar): string {
  return `${bar.open_time_ms}:${bar.open.toFixed(4)}:${bar.close.toFixed(4)}:${bar.high.toFixed(4)}:${bar.low.toFixed(4)}`;
}

async function waitCycleIdle(s: Internal, maxMs = 30_000): Promise<void> {
  const start = Date.now();
  while (s.cycle_busy && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 40));
  }
}

/**
 * SAFETY SL as a true cushion — NOT dealing-rules minimum.
 * Target ~0.20% of price, at least ~2.5× broker min / wide vs spread,
 * so noise does not stop every trade (slightly tighter than 0.25%).
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

  const pctCushion = abs * 0.002; // 0.20% safety cushion (was 0.25%)
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

/** Cushion stopDistance in Capital POINTS (≥ 2.5× min, ~0.20% of price when point size known). */
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

/** Stop only entry brains — never kill a robot sitting on an open trade (HardInv must live). */
export async function stopEntryRobotsForAccount(accountId: number): Promise<void> {
  for (const s of [...sessions.values()]) {
    if (s.account_id === accountId && s.running && s.entry_enabled) {
      if (s.open_side || s.deal_id) {
        s.entry_enabled = false;
        s.pending_entry = null;
        pushTick(s, {
          phase: 'INFO',
          bid: null,
          ask: null,
          mid: s.last_mid,
          detail: 'ENTRY brain OFF · open trade kept · MANAGE-ONLY (HardInv/Peak live)',
        });
      } else {
        await stopRobotSession(s.id);
      }
    }
  }
}

/** Stop manage-only robots that are already flat (client STOP, no open trade). */
export async function stopFlatManageRobotsForAccount(accountId: number): Promise<void> {
  for (const s of [...sessions.values()]) {
    if (
      s.account_id === accountId &&
      s.running &&
      !s.entry_enabled &&
      !s.open_side &&
      !s.deal_id &&
      // MANAGE mode may be local-flat while broker still open (attach lag) — keep HardInv
      s.mode !== 'MANAGE'
    ) {
      await stopRobotSession(s.id);
    }
  }
}

export async function stopRobotSession(id: string): Promise<RobotSession | null> {
  const s = sessions.get(id);
  if (!s) return null;
  // Open trade → demote to manage-only; never clear HardInv timer
  if (s.open_side || s.deal_id) {
    s.entry_enabled = false;
    s.pending_entry = null;
    pushTick(s, {
      phase: 'INFO',
      bid: null,
      ask: null,
      mid: s.last_mid,
      detail: 'STOP entry · open trade kept · MANAGE-ONLY (HardInv/Peak live)',
    });
    return publicSession(s);
  }
  s.running = false;
  s.trading_enabled = false;
  s.pending_entry = null;
  s.entry_close_latch = null;
  s.stopped_at = new Date().toISOString();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  // Drain in-flight Capital create/close so restart cannot race a second entry
  await waitCycleIdle(s);
  s.cycle_busy = false;
  s.cycle_busy_since = 0;
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

/**
 * Fresh fill: broker open_level beats provisional mid/ref.
 * If list fails / open_level missing, keep provisional.
 */
export function preferBrokerOpenLevel(
  provisional: number | null | undefined,
  openLevel: number | null | undefined
): number | null {
  if (openLevel != null && Number.isFinite(openLevel)) return openLevel;
  if (provisional != null && Number.isFinite(provisional)) return provisional;
  return null;
}

/** Prefer Capital createdDate for entry_at so TimeDecay survives restart. */
export function preferBrokerEntryAt(
  localIso: string | null | undefined,
  brokerCreatedAt: string | null | undefined,
  nowIso = new Date().toISOString()
): string {
  // Broker open time is source of truth — never keep a recovery "now" stamp over it
  if (brokerCreatedAt) return brokerCreatedAt;
  return localIso || nowIso;
}

function syncFromBrokerOpen(
  s: Internal,
  broker: CapitalOpenPosition,
  quoteMid: number | null
): void {
  if (s.entry_price == null) s.entry_price = broker.open_level ?? quoteMid;
  s.entry_at = preferBrokerEntryAt(s.entry_at, broker.created_at);
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
    s.exit_deal_fails = (s.exit_deal_fails || 0) + 1;
    const listed = await listCapitalOpenPositions(session);
    if (listed.ok && !matchOpenOnEpic(listed.positions, s.epic)) {
      if (s.open_side) s.last_closed_side = s.open_side;
      pushTick(s, {
        phase: 'INFO',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `EXIT: no dealId + broker flat — clear ghost · FLAT · same-dir lock 3m ≠ ${s.last_closed_side || '—'}`,
      });
      s.closed_at_ms = Date.now();
      clearTradeState(s);
      return;
    }
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `EXIT blocked — no dealId (cannot close). MANAGE · fails=${s.exit_deal_fails}`,
    });
    s.mode = 'MANAGE';
    return;
  }
  s.exit_deal_fails = 0;

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
  if (s.open_side) s.last_closed_side = s.open_side;
  pushTick(s, {
    phase: 'EXIT',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: `CLOSED ${s.open_side} ${s.display_name} · ${result.detail} · ${reason} · same-dir lock 3m ≠ ${s.last_closed_side}`,
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
  return withEpicEntryLock(s.account_id, s.epic, () =>
    enterTradeLocked(session, s, direction, quote, reason, setupType)
  );
}

async function enterTradeLocked(
  session: CapitalSession,
  s: Internal,
  direction: 'BUY' | 'SELL',
  quote: CapitalMarketQuote,
  reason: string,
  setupType?: string | null
) {
  if (!s.running) {
    pushTick(s, {
      phase: 'WAIT',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: 'ENTRY aborted — robot stopped',
    });
    s.pending_entry = null;
    return;
  }
  if (sameDirectionBlocked(direction, s.last_closed_side, s.closed_at_ms)) {
    const left = sameDirLockLeftSec(s.closed_at_ms);
    pushTick(s, {
      phase: 'WAIT',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: flipFilterReason(direction, s.last_closed_side!, left),
    });
    s.pending_entry = null;
    return;
  }
  // HARD RULE: never entry while any trade open on this epic
  const listed = await listCapitalOpenPositions(session);
  if (!listed.ok) {
    pushTick(s, {
      phase: 'WAIT',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `ENTRY blocked — position list failed (${listed.detail}) · fail-closed`,
    });
    // Keep pending_entry — retry same bar when list recovers
    return;
  }
  if (!s.running) {
    s.pending_entry = null;
    return;
  }
  const existing = matchOpenOnEpic(listed.positions, s.epic);
  if (existing) {
    s.open_side = existing.direction;
    s.deal_id = existing.deal_id;
    syncFromBrokerOpen(s, existing, quote.mid);
    s.mode = 'MANAGE';
    if (existing.stop_level != null) s.safety_sl = existing.stop_level;
    s.pending_entry = null;
    pushTick(s, {
      phase: 'WAIT',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `ONE TRADE ONLY — broker already open ${existing.direction} dealId=${existing.deal_id} · no new entry`,
    });
    return;
  }

  pushTick(s, {
    phase: 'DECIDE',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: `ENTRY ${direction} · ${reason} · lot=${s.lot_size}`,
  });

  const mid = quote.mid;
  if (mid == null || !Number.isFinite(mid)) {
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: 'ENTRY blocked — no mid for safety SL',
    });
    return;
  }

  // SAFETY SL cushion (~0.20% / ≥2.5× min) — not dealing-rules minimum
  const minPts = quote.min_stop_points;
  const minPrice = quote.min_stop_distance ?? null;
  const unit = (quote.min_stop_unit || 'POINTS').toUpperCase();
  const useDistance = minPts != null && minPts > 0 && !unit.includes('PERCENT');
  const loosenSteps = [1, 1.15, 1.35, 1.6, 2.0];

  let stopLevel: number | null = null;
  let usedStopDistance: number | null = null;
  let result: Awaited<ReturnType<typeof createCapitalPosition>> | null = null;

  if (useDistance) {
    for (const loosen of loosenSteps) {
      if (!s.running) {
        s.pending_entry = null;
        return;
      }
      const basePts = safetyStopDistancePts(mid, minPts!, quote.point_size ?? null);
      const distPts = Math.max(basePts * loosen, minPts! * 3);
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
        detail: `Capital SAFETY SL cushion stopDistance=${stopDistance} pts (min=${minPts} · ~level ${
          expect ?? 'n/a'
        } · x${loosen})`,
      });
      result = await createCapitalPosition(session, {
        epic: s.epic,
        direction,
        size: s.lot_size,
        stopDistance,
      });
      if (result.ok) {
        usedStopDistance = stopDistance;
        stopLevel = expect;
        break;
      }
      if (!/stop|distance|validation|reject|attached|level/i.test(result.detail)) break;
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `SL distance rejected — loosen x${loosen}: ${result.detail}`,
      });
    }
  }

  if (!result?.ok) {
    for (const loosen of loosenSteps) {
      if (!s.running) {
        s.pending_entry = null;
        return;
      }
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
        detail: `Capital SAFETY SL try stopLevel=${level} (dist≈${dist.toFixed(5)} · minPrice=${
          minPrice ?? 'n/a'
        } · spread=${quote.spread ?? 'n/a'} · x${loosen})`,
      });
      result = await createCapitalPosition(session, {
        epic: s.epic,
        direction,
        size: s.lot_size,
        stopLevel: level,
      });
      if (result.ok) {
        stopLevel = level;
        break;
      }
      if (!/stop|distance|validation|reject|attached|level/i.test(result.detail)) break;
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `SL level rejected — loosen x${loosen}: ${result.detail}`,
      });
    }
  }

  if (!result?.ok) {
    // Fail closed — never open naked without SAFETY SL (HardInv alone is not enough)
    s.error = result?.detail || 'Safety SL not accepted';
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `ENTRY blocked — SAFETY SL path failed (${result?.detail || 'unknown'}) · no naked order`,
    });
    return;
  }

  s.pending_entry = null;
  s.orders_placed += 1;
  s.open_side = direction;
  s.mode = 'MANAGE';
  s.last_deal_reference = result.deal_reference || null;
  // Temporary — prefer broker open_level after dealId + list (mid is only fallback)
  s.entry_price = mid;
  s.entry_at = new Date().toISOString();
  s.mfe = 0;
  s.mae = 0;
  s.peak_favorable = mid;
  s.peak_retention = null;
  s.unrealized = 0;
  s.safety_sl = stopLevel != null && Number.isFinite(stopLevel) ? stopLevel : null;
  s.error = null;

  const dealId = await resolveDealId(session, s, result.deal_reference);
  if (dealId) s.deal_id = dealId;

  // Sync broker truth: open_level + stopLevel + created_at (mid/now only provisional)
  if (dealId) {
    try {
      const again = await listCapitalOpenPositions(session);
      const pos = again.ok ? matchOpenOnEpic(again.positions, s.epic) : null;
      const brokerEntry = preferBrokerOpenLevel(s.entry_price, pos?.open_level);
      if (brokerEntry != null) {
        s.entry_price = brokerEntry;
        s.peak_favorable = brokerEntry;
      }
      if (pos?.stop_level != null && Number.isFinite(pos.stop_level)) {
        s.safety_sl = pos.stop_level;
      }
      if (pos) s.entry_at = preferBrokerEntryAt(s.entry_at, pos.created_at);
    } catch {
      /* mid / computed SL remain as temporary fallback */
    }
  }

  pushTick(s, {
    phase: 'ORDER',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: `ORDER ENTRY ${direction} ${s.display_name} lot=${s.lot_size} · entry ${
      s.entry_price ?? '—'
    } · SL ${s.safety_sl ?? 'none'}${
      usedStopDistance != null ? ` (dist ${usedStopDistance}pts)` : ''
    } · ${result.detail}${dealId ? ` · dealId=${dealId}` : ''}`,
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
        (s.entry_price ?? quote.mid) || 0,
        s.lot_size,
      ]
    );
  } catch {
    /* Capital order already live */
  }
}


async function robotCycle(s: Internal) {
  if (!s.running || s.cycle_busy) return;
  s.cycle_busy = true;
  s.cycle_busy_since = Date.now();
  try {
    await robotCycleLocked(s);
  } finally {
    s.cycle_busy = false;
    s.cycle_busy_since = 0;
  }
}

async function robotCycleLocked(s: Internal) {
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

  const leased = await withCapitalAccountSession(
    {
      environment: conn.environment,
      apiKey: creds.api_key || '',
      identifier: (conn.identifier || '').trim(),
      password: creds.password || '',
      connectionId: s.connection_id,
      capitalAccountId,
      requireAccountId: true,
    },
    async (session) => {
  try {
    const quote = await fetchCapitalMarketQuote(session, s.epic);
    if (!quote.raw_ok) {
      s.reads_fail += 1;
      s.error = quote.detail || 'No quote';
      pushTick(s, {
        phase: 'ERROR',
        bid: null,
        ask: null,
        mid: null,
        detail: quote.detail || `No quote for ${s.display_name} (${s.epic})`,
      });
      return;
    }

    s.reads_ok += 1;
    s.error = null;
    s.last_quote_at = new Date().toISOString();
    if (quote.epic && quote.epic !== s.epic) {
      s.epic = quote.epic;
    }

    // Market closed / offline → park entries (anti-spam Capital).
    // CRITICAL: if a trade is open, still sync + HardInv/Peak — never skip manage.
    if (!marketAllowsTrading(quote.market_status)) {
      if (s.open_side || s.deal_id) {
        // Keep fast cadence while managing — 90s park would delay HardInv
        setRobotCadence(s, ACTIVE_CADENCE_MS);
        const listedPark = await listCapitalOpenPositions(session);
        if (listedPark.ok) {
          const brokerPark = matchOpenOnEpic(listedPark.positions, s.epic);
          if (brokerPark) {
            s.open_side = brokerPark.direction;
            s.deal_id = brokerPark.deal_id;
            syncFromBrokerOpen(s, brokerPark, quote.mid);
            s.mode = 'MANAGE';
            if (brokerPark.upl != null) s.unrealized = brokerPark.upl;
          } else if (s.open_side) {
            const closedSide = s.open_side;
            s.last_closed_side = closedSide;
            s.closed_at_ms = Date.now();
            clearTradeState(s);
            pushTick(s, {
              phase: 'INFO',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: `MARKET ${quote.market_status || 'CLOSED'} · broker flat — trade closed · FLAT`,
            });
            return;
          }
        }
        if (s.open_side && quote.mid != null) {
          if (s.entry_price == null) s.entry_price = quote.mid;
          updateExcursion(s, quote.mid);
          const lossPark = decideBestOutcomeExit(s, quote.mid, 'live_loss');
          if (lossPark.hardinv_breaching) {
            if (!s.hardinv_breach_since_ms) s.hardinv_breach_since_ms = Date.now();
          } else {
            s.hardinv_breach_since_ms = 0;
          }
          if (lossPark.exit) {
            await exitTrade(session, s, quote, lossPark.reason);
            return;
          }
          if (s.peak_protect_armed) {
            const peakPark = decideBestOutcomeExit(s, quote.mid, 'peak_protect_only');
            if (peakPark.exit) {
              await exitTrade(session, s, quote, peakPark.reason);
              return;
            }
          }
          pushTick(s, {
            phase: 'MANAGE',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: `MARKET ${quote.market_status || 'CLOSED'} · still MANAGE ${s.open_side} · HardInv/Peak live · no new entry`,
          });
          return;
        }
        pushTick(s, {
          phase: 'MANAGE',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `MARKET ${quote.market_status || 'CLOSED'} · open ${s.open_side || '?'} · wait mid for HardInv`,
        });
        return;
      }
      setRobotCadence(s, CLOSED_MARKET_CADENCE_MS);
      // Warm the 30m zone from history while closed — so TRADEABLE does not start at 0/90
      try {
        await seedZoneFromMinuteHistory(session, s, quote);
      } catch {
        /* park tick below still runs */
      }
      const now = Date.now();
      if (now - s.last_market_closed_tick_ms >= CLOSED_MARKET_TICK_EVERY_MS) {
        s.last_market_closed_tick_ms = now;
        refreshEntryWatch(s, {
          status_override: 'SEEDING',
          last_reason: `MARKET ${quote.market_status || 'CLOSED'} · zona ${s.closedBars.length}/${MIN_BARS_FOR_ZONE}`,
        });
        pushTick(s, {
          phase: 'WAIT',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `MARKET ${quote.market_status || 'CLOSED'} — park robot (no entry / no position spam) · poll ${
            CLOSED_MARKET_CADENCE_MS / 1000
          }s until TRADEABLE · zona ${s.closedBars.length}/${MIN_BARS_FOR_ZONE}`,
        });
      }
      return;
    }

    // Restore normal cadence after a successful tradeable read (may have been slowed by 429 / closed)
    setRobotCadence(s, ACTIVE_CADENCE_MS);
    s.last_mid = quote.mid;
    s.last_bid = quote.bid;
    s.last_ask = quote.ask;

    // Multi-provider read — skip while 10s bar is flat so Capital lock frees faster
    // for SECOND enrich (flat O=H=L=C is the zero-trade failure mode).
    const flatNow = isFlatTenBar(s.ohlcState.last_closed);
    if (!flatNow && Date.now() - s.last_multi_feed_ms >= 4_000) {
      s.last_multi_feed_ms = Date.now();
      try {
        s.multiFeed = await readMultiFeedPrice(s.epic, { anchorMid: quote.mid });
      } catch {
        /* keep previous multiFeed snapshot */
      }
    } else if (s.multiFeed && quote.mid != null) {
      // Re-anchor pick every tick even if multi snapshot is cached
    }
    const picked = pickOhlcMid(quote.mid, s.multiFeed);
    s.feed_source = picked.source;
    s.feed_contributing = s.multiFeed?.contributing ?? 0;
    s.feed_sender_count = s.multiFeed?.sender_count ?? 0;
    s.feed_agreement = s.multiFeed?.agreement ?? null;

    // Live mid on wall clock — Capital updateTime jumps with price and closed flat bars
    const ohlcMid = picked.mid ?? quote.mid;
    if (ohlcMid != null) {
      s.ohlcState = updateTenSecondOhlc(s.ohlcState, ohlcMid, Date.now());
      s.ohlc_10s = publicOhlc10s(s.ohlcState);
      if (s.ohlcState.just_closed && s.ohlcState.last_closed) {
        s.entry_close_latch = s.ohlcState.last_closed;
        applyRobotRegime(s, [s.ohlcState.last_closed]);
      }
    }

    // Sparse REST polls → flat CLOSED bars. SECOND (or MINUTE fallback) restores range.
    // When flat: enrich EVERY cycle (ignore 8s throttle) — otherwise zero trades forever.
    const needEnrich =
      isFlatTenBar(s.ohlcState.last_closed) ||
      Date.now() - s.last_second_ohlc_ms >= SECOND_OHLC_ENRICH_MS;
    if (needEnrich) {
      s.last_second_ohlc_ms = Date.now();
      try {
        const secs = await fetchCapitalPrices(session, s.epic, 'SECOND', 50);
        if (secs.ok && secs.candles.length >= 2) {
          const beforeKey = s.ohlcState.last_closed
            ? closedBarKey(s.ohlcState.last_closed)
            : '';
          const beforeFlat = isFlatTenBar(s.ohlcState.last_closed);
          s.ohlcState = enrichOhlcWithSecondCandles(s.ohlcState, secs.candles, Date.now());
          s.ohlc_10s = publicOhlc10s(s.ohlcState);
          const after = s.ohlcState.last_closed;
          const afterKey = after ? closedBarKey(after) : '';
          pushTick(s, {
            phase: 'INFO',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: `10s SECOND enrich · candles=${secs.candles.length} · flatWas=${beforeFlat} · justClosed=${s.ohlcState.just_closed} · O=${after?.open.toFixed(2) ?? '—'} H=${after?.high.toFixed(2) ?? '—'} L=${after?.low.toFixed(2) ?? '—'} C=${after?.close.toFixed(2) ?? '—'} · body=${after ? (bodyPct(after) * 100).toFixed(3) : '—'}% · rng=${after ? (rangePct(after) * 100).toFixed(3) : '—'}% · ticks=${after?.ticks ?? 0} · ${secs.detail}`,
          });
          if (s.ohlcState.just_closed && after) {
            s.entry_close_latch = after;
            if (afterKey !== beforeKey || afterKey !== s.last_closed_bar_key) {
              applyRobotRegime(s, [after]);
            }
          }
        } else {
          // SECOND unavailable — last-resort: last Capital MINUTE → synthetic 10s with real range
          const mins = await fetchCapitalPrices(session, s.epic, 'MINUTE', 3);
          if (mins.ok && mins.candles.length >= 1) {
            const syn = expandMinutesToTen(mins.candles.slice(-2), Date.now());
            const lastSyn = syn.length >= 2 ? syn[syn.length - 2]! : syn[syn.length - 1];
            if (lastSyn && isFlatTenBar(s.ohlcState.last_closed) && !isFlatTenBar(lastSyn)) {
              s.ohlcState = {
                forming: s.ohlcState.forming,
                last_closed: lastSyn,
                just_closed: true,
              };
              s.ohlc_10s = publicOhlc10s(s.ohlcState);
              s.entry_close_latch = lastSyn;
              applyRobotRegime(s, [lastSyn]);
              pushTick(s, {
                phase: 'INFO',
                bid: quote.bid,
                ask: quote.ask,
                mid: quote.mid,
                detail: `10s MINUTE fallback enrich · SECOND failed (${secs.detail || 'no candles'}) · O=${lastSyn.open.toFixed(2)} H=${lastSyn.high.toFixed(2)} L=${lastSyn.low.toFixed(2)} C=${lastSyn.close.toFixed(2)} · body=${(bodyPct(lastSyn) * 100).toFixed(3)}%`,
              });
            } else {
              pushTick(s, {
                phase: 'WAIT',
                bid: quote.bid,
                ask: quote.ask,
                mid: quote.mid,
                detail: `10s enrich FAIL · SECOND ${secs.detail || 'empty'} · MINUTE ${mins.detail || 'empty'} · still flat`,
              });
            }
          } else {
            pushTick(s, {
              phase: 'WAIT',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: `10s enrich FAIL · SECOND ${secs.detail || 'empty'} · no MINUTE fallback · still flat O=H=L=C`,
            });
          }
        }
      } catch (e) {
        pushTick(s, {
          phase: 'WAIT',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `10s enrich ERROR · ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    // Seed 30m zone early — before manage-only / trading-off returns (multi-feed never fills history)
    await seedZoneFromMinuteHistory(session, s, quote);

    // Sync truth from broker — source of ONE TRADE ONLY
    const listed = await listCapitalOpenPositions(session);
    let brokerOpen: CapitalOpenPosition | null = null;
    let positionsUncertain = false;
    if (listed.ok) {
      brokerOpen = matchOpenOnEpic(listed.positions, s.epic);
      if (brokerOpen) {
        s.open_side = brokerOpen.direction;
        s.deal_id = brokerOpen.deal_id;
        syncFromBrokerOpen(s, brokerOpen, quote.mid);
        s.mode = 'MANAGE';
        if (brokerOpen.upl != null) s.unrealized = brokerOpen.upl;
      } else if (s.open_side) {
        // Local thought open but broker flat → treat as closed
        const closedSide = s.open_side;
        s.last_closed_side = closedSide;
        pushTick(s, {
          phase: 'INFO',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `Broker flat on this epic — trade closed externally · FLAT · same-dir lock 3m ≠ ${closedSide}`,
        });
        s.closed_at_ms = Date.now();
        clearTradeState(s);
      }
    } else {
      positionsUncertain = true;
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `Position sync warn: ${listed.detail} · fail-closed (no new entry until list OK)`,
      });
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
      } · UPL=${s.unrealized != null ? s.unrealized.toFixed(5) : '—'} · MFE=${s.mfe.toFixed(5)} · regime=${s.regime}`,
    });
    if (s.open_side) {
      refreshEntryWatch(s, { status_override: 'MANAGE', last_reason: `MANAGE ${s.open_side}` });
    }

    // Trading OFF: still manage/exit open trades; block only new entries
    if (!s.trading_enabled && !(s.open_side || brokerOpen)) {
      refreshEntryWatch(s, {
        last_reason: `Trading OFF · lasa · zona ${s.closedBars.length}/${MIN_BARS_FOR_ZONE}`,
      });
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `Trading OFF — reading only · zona ${s.closedBars.length}/${MIN_BARS_FOR_ZONE} · regime=${s.regime}`,
      });
      return;
    }

    // ——— MANAGE open trade: never send entry ———
    if (s.open_side || brokerOpen) {
      if (!s.trading_enabled) {
        // allow HardInv / Peak exits even when operator paused new entries
      }
      s.mode = 'MANAGE';
      if (quote.mid == null) {
        pushTick(s, {
          phase: 'WAIT',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: 'MANAGE · no mid — wait quote',
        });
        return;
      }

      // LIVE loss: Soft HardInv with grace + confirm (no single-wick magic minus)
      const lossDec = decideBestOutcomeExit(s, quote.mid, 'live_loss');
      if (lossDec.hardinv_breaching) {
        if (!s.hardinv_breach_since_ms) {
          s.hardinv_breach_since_ms = Date.now();
          pushTick(s, {
            phase: 'MANAGE',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: `HardInv BREACH · waiting confirm (anti wick) · ${lossDec.reason || 'beyond SL'}`,
          });
        }
      } else {
        s.hardinv_breach_since_ms = 0;
      }
      if (lossDec.exit) {
        await exitTrade(session, s, quote, lossDec.reason);
        return;
      }

      // PROFIT: hold on Capital 1m continue; reverse → PeakProtect 25% giveback arms + trails live
      if (Date.now() - s.last_manage_minute_fetch_ms >= 2_000) {
        s.last_manage_minute_fetch_ms = Date.now();
        try {
          const mins = await fetchCapitalMinutePrices(session, s.epic, 8);
          if (mins.ok && mins.candles.length) {
            s.last_minute_candles = mins.candles;
          }
        } catch {
          /* keep previous minutes */
        }
      }

      const closed1m = lastClosedCapitalMinute(s.last_minute_candles);
      if (closed1m && s.open_side && s.entry_price != null) {
        const prev1m = prevClosedCapitalMinute(s.last_minute_candles);
        const key = capitalMinuteCandleKey(closed1m, prev1m);
        if (key !== s.last_1m_profit_exit_key) {
          const policy = closed1mProfitPolicy(
            s.open_side,
            { open: closed1m.open, close: closed1m.close },
            prev1m ? { open: prev1m.open, close: prev1m.close } : null
          );
          s.last_1m_profit_exit_key = key;

          if (policy === 'continue') {
            s.peak_protect_armed = false;
            pushTick(s, {
              phase: 'MANAGE',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: '1m continue · HOLD profit · PeakProtect OFF',
            });
          } else if (policy === 'wait') {
            pushTick(s, {
              phase: 'MANAGE',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: `1m wait · HOLD profit · PeakProtect ${
                s.peak_protect_armed ? 'ON (live trail)' : 'OFF'
              }`,
            });
          } else if (policy === 'reverse') {
            s.peak_protect_armed = true;
            pushTick(s, {
              phase: 'MANAGE',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: '1m reverse · PeakProtect ARMED · trailing live giveback 25%',
            });
            const peakAtClose = decideBestOutcomeExit(
              s,
              closed1m.close,
              'peak_protect_only'
            );
            if (peakAtClose.exit) {
              await exitTrade(session, s, quote, peakAtClose.reason);
              return;
            }
          }
        }
      }

      // Once armed by reverse — PeakProtect-only on LIVE mark
      if (s.peak_protect_armed && s.open_side) {
        const peakDec = decideBestOutcomeExit(s, quote.mid, 'peak_protect_only');
        if (peakDec.exit) {
          await exitTrade(session, s, quote, peakDec.reason);
          return;
        }
      }

      // Green Target / TimeDecay — winners must not wait only for Peak/HardInv
      if (s.open_side && s.entry_price != null && quote.mid != null) {
        const favNow = favorableMove(s.open_side, s.entry_price, quote.mid);
        if (favNow > 0) {
          const tpDec = decideBestOutcomeExit(s, quote.mid, 'target_time');
          if (tpDec.exit) {
            await exitTrade(session, s, quote, tpDec.reason);
            return;
          }
        }
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
        } · loss=live · plus=1mClose(continue→HOLD·reverse→Peak25%)·peakLive=${
          s.peak_protect_armed ? 'ON' : 'OFF'
        } · no new orders`,
      });
      return;
    }

    // ——— FLAT: entry only after close (and only if entry_enabled) ———
    if (!s.trading_enabled) {
      s.entry_close_latch = null;
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: 'Trading OFF — flat · no entry',
      });
      return;
    }
    if (positionsUncertain) {
      // Still expire stale pending on bar rollover — don't keep a stuck setup across bars
      const pendBar = s.ohlcState.last_closed;
      const pendKey = pendBar ? closedBarKey(pendBar) : '';
      if (s.pending_entry && s.pending_entry.bar_key !== pendKey) {
        s.pending_entry = null;
      }
      // Keep entry_close_latch — retry decide next tick when list OK
      refreshEntryWatch(s, {
        status_override: 'WAITING_TRIGGER',
        last_reason: 'Position list fail — no entry until sync OK',
      });
      return;
    }
    if (!s.entry_enabled) {
      s.entry_close_latch = null;
      s.mode = s.open_side ? 'MANAGE' : 'FLAT';
      refreshEntryWatch(s, {
        status_override: 'MANAGE_ONLY',
        last_reason: 'MANAGE-ONLY · nav lokālā entry smadzeņu',
      });
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail:
          'MANAGE-ONLY · waiting for central pipeline intent (no local BUY/SELL brain)',
      });
      return;
    }

    s.mode = 'ENTRY';
    const sinceClose = Date.now() - (s.closed_at_ms || 0);
    const POST_CLOSE_COOLDOWN_MS = 8_000;
    if (s.closed_at_ms > 0 && sinceClose < POST_CLOSE_COOLDOWN_MS) {
      const left = Math.ceil((POST_CLOSE_COOLDOWN_MS - sinceClose) / 1000);
      refreshEntryWatch(s, {
        cooldown_left_s: left,
        last_reason: `Cooldown ${left}s pēc close`,
      });
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `cooldown ${left}s after close · stop chop re-entry · ${s.entry_watch?.looking_for || ''}`,
      });
      return;
    }

    if (quote.mid == null) {
      refreshEntryWatch(s, {
        status_override: 'SEEDING',
        last_reason: `ENTRY · no mid — wait quote · zona ${s.closedBars.length}/${MIN_BARS_FOR_ZONE}`,
      });
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `ENTRY · no mid — wait quote · zona ${s.closedBars.length}/${MIN_BARS_FOR_ZONE}`,
      });
      return;
    }

    // Soft advisory only — public feeds must never freeze Capital entries
    const feedGate = allowEntryFromFeeds(s.multiFeed);
    if (!feedGate.ok) {
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `FEED NOTE · ${feedGate.reason}`,
      });
      // do not return — Capital local path continues
    }

    const bar = s.ohlcState.last_closed;
    const latchRaw = s.entry_close_latch;
    // Drop latch if the close is older than ~1.5× bar — avoid stale arms after Capital gaps
    if (latchRaw && Date.now() - latchRaw.open_time_ms > 15_000) {
      s.entry_close_latch = null;
    }
    const latch = s.entry_close_latch;
    /** Prefer the latched live close when seed replaced last_closed */
    const entryBar =
      latch &&
      (!bar ||
        closedBarKey(latch) === closedBarKey(bar) ||
        s.ohlcState.just_closed ||
        latch.open_time_ms >= (bar.open_time_ms || 0))
        ? latch
        : bar;
    const ohlc = s.ohlc_10s;
    const ohlcLine = entryBar
      ? `10s O=${entryBar.open.toFixed(2)} H=${entryBar.high.toFixed(2)} L=${entryBar.low.toFixed(2)} C=${entryBar.close.toFixed(2)} ${s.regime} · feeds ${
          s.feed_contributing || 0
        }/${s.feed_sender_count || 0} ${s.feed_source || 'LOCAL'} ${s.feed_agreement || ''}`
      : `10s OHLC seeding · feeds ${s.feed_contributing || 0}/${s.feed_sender_count || 0}`;

    let direction: 'BUY' | 'SELL' | null = null;
    let reason = '';
    let setupType: string | null = null;
    const barKey = entryBar ? closedBarKey(entryBar) : '';
    if (s.pending_entry && s.pending_entry.bar_key !== barKey) {
      s.pending_entry = null;
    }

    const onCloseTick = Boolean(
      entryBar &&
        (s.ohlcState.just_closed ||
          (latch && closedBarKey(latch) === closedBarKey(entryBar)))
    );

    if (onCloseTick && entryBar) {
      if (!regimeAllowedForEntry(s.regime)) {
        s.entry_close_latch = null;
        refreshEntryWatch(s, {
          status_override: 'REGIME_OFF',
          last_reason: `${s.regime} OFF kalibrācijā`,
        });
        pushTick(s, {
          phase: 'DECIDE',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `${ohlcLine} · ENTRY WATCH · ${s.entry_watch?.looking_for} · regime OFF · no entry`,
        });
      } else {
        const sig = decideEntryFrom10sRegime(entryBar, s.regime);
        if (sig) {
          if (sameDirectionBlocked(sig.direction, s.last_closed_side, s.closed_at_ms)) {
            const need = requiredFlipSide(s.last_closed_side, s.closed_at_ms);
            const left = sameDirLockLeftSec(s.closed_at_ms);
            s.pending_entry = null;
            s.entry_close_latch = null;
            refreshEntryWatch(s, {
              status_override: 'FLIP_FILTER',
              last_reason: flipFilterReason(sig.direction, s.last_closed_side!, left),
            });
            pushTick(s, {
              phase: 'DECIDE',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: `${ohlcLine} · FLIP LOCK 3m · blocked ${sig.direction} ${sig.setup} · need ${need} · ${left}s left (last ${s.last_closed_side})`,
            });
          } else {
            direction = sig.direction;
            setupType = sig.setup;
            reason = sig.reason;
            s.entry_close_latch = null;
            refreshEntryWatch(s, {
              status_override: 'ARMED',
              last_reason: sig.reason,
            });
            pushTick(s, {
              phase: 'DECIDE',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: `ARMED ${sig.direction} ${sig.setup} · ${s.entry_watch?.looking_for} · ${s.entry_watch?.bar_vs_trigger}`,
            });
          }
        } else {
          s.entry_close_latch = null;
          refreshEntryWatch(s, {
            status_override: 'WAITING_TRIGGER',
            last_reason: `${s.regime} · trigeris nav · nākamā svece`,
          });
          pushTick(s, {
            phase: 'DECIDE',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: `${ohlcLine} · WATCH · ${s.entry_watch?.looking_for} · ${s.entry_watch?.bar_vs_trigger} · wait next candle`,
          });
        }
      }
    } else if (s.pending_entry && s.pending_entry.bar_key === barKey && entryBar) {
      // Retry failed order on the same closed 10s bar — re-validate regime + flip lock
      if (!regimeAllowedForEntry(s.regime)) {
        s.pending_entry = null;
        refreshEntryWatch(s, {
          status_override: 'REGIME_OFF',
          last_reason: `${s.regime} OFF · cleared pending retry`,
        });
        pushTick(s, {
          phase: 'DECIDE',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `${ohlcLine} · pending cleared · regime OFF`,
        });
      } else if (
        sameDirectionBlocked(s.pending_entry.direction, s.last_closed_side, s.closed_at_ms)
      ) {
        const blockedDir = s.pending_entry.direction;
        const left = sameDirLockLeftSec(s.closed_at_ms);
        s.pending_entry = null;
        refreshEntryWatch(s, {
          status_override: 'FLIP_FILTER',
          last_reason: flipFilterReason(blockedDir, s.last_closed_side!, left),
        });
      } else {
        direction = s.pending_entry.direction;
        setupType = s.pending_entry.setup;
        reason = `${s.pending_entry.reason} · retry`;
        refreshEntryWatch(s, {
          status_override: 'ARMED',
          last_reason: reason,
        });
        pushTick(s, {
          phase: 'DECIDE',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `ARMED RETRY ${direction} · same bar ${barKey} · ${reason}`,
        });
      }
    } else {
      refreshEntryWatch(s, {
        status_override: entryBar ? 'FORMING' : 'SEEDING',
      });
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `${ohlcLine} · ${s.entry_watch?.looking_for || 'WATCH'} · forming C=${
          ohlc.forming_c != null ? ohlc.forming_c.toFixed(2) : '—'
        } · ${s.entry_watch?.bar_vs_trigger || 'wait bar close'}`,
      });
    }

    if (!direction) return;
    if (!s.running) return;
    s.pending_entry = {
      direction,
      reason,
      setup: setupType,
      bar_key: barKey || (entryBar ? closedBarKey(entryBar) : ''),
    };
    await enterTrade(session, s, direction, quote, reason, setupType);
  } catch (err) {
    s.reads_fail += 1;
    const detail = err instanceof Error ? err.message : String(err);
    s.error = detail;
    pushTick(s, { phase: 'ERROR', bid: null, ask: null, mid: null, detail });
  }
  // Do NOT close pooled Capital session each tick — that caused HTTP 429 login spam
    }
  );

  if (!leased.ok) {
    s.reads_fail += 1;
    s.error = leased.result.detail;
    const rateLimited =
      leased.result.status === 429 || /rate-limit|too-many|cooldown/i.test(leased.result.detail);
    const timedOut =
      leased.result.status === 408 || /timeout|hung|lock (wait|hold)/i.test(leased.result.detail);
    pushTick(s, {
      phase: rateLimited || timedOut ? 'WAIT' : 'ERROR',
      bid: null,
      ask: null,
      mid: null,
      detail: rateLimited
        ? `RATE LIMIT — ${leased.result.detail}`
        : timedOut
          ? `CAPITAL TIMEOUT — ${leased.result.detail} · retry next tick · zona ${s.closedBars.length}/${MIN_BARS_FOR_ZONE}`
          : `Session fail: ${leased.result.detail}`,
    });
    refreshEntryWatch(s, {
      status_override: 'SEEDING',
      last_reason: timedOut
        ? `Capital timeout · zona ${s.closedBars.length}/${MIN_BARS_FOR_ZONE}`
        : leased.result.detail,
    });
    if (rateLimited) setRobotCadence(s, 5_000);
    else if (timedOut) setRobotCadence(s, 3_000);
  }
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

  // Broker epic 1:1 only — no ILIKE / display_name remap / invented default
  const exact = await pool.query(
    `SELECT epic, display_name FROM capital_markets
     WHERE broker_connection_id = $1 AND epic = $2
     ORDER BY updated_at DESC LIMIT 1`,
    [acc.connection_id, epic]
  );
  if (!exact.rows.length) {
    throw new Error(
      `Epic "${epic}" not in capital_markets for this account — Pull Capital markets and pick broker epic 1:1`
    );
  }
  epic = exact.rows[0].epic as string;
  displayName = String(exact.rows[0].display_name || epic);

  const lot = Number(input.lot_size);
  if (!Number.isFinite(lot) || lot <= 0) throw new Error('lot_size must be > 0');

  const id = robotIdFor(acc.id, epic);
  const existing = sessions.get(id);
  if (existing?.running) {
    await stopRobotSession(id);
  } else if (existing?.cycle_busy) {
    existing.running = false;
    await waitCycleIdle(existing);
    existing.cycle_busy = false;
    existing.cycle_busy_since = 0;
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
    last_bid: null,
    last_ask: null,
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
    last_closed_side: null,
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
    last_second_ohlc_ms: 0,
    last_closed_bar_key: '',
    closedBars: [],
    last_multi_feed_ms: 0,
    multiFeed: null,
    feed_source: 'NONE',
    feed_contributing: 0,
    feed_sender_count: 0,
    feed_agreement: null,
    regime: 'UNKNOWN',
    last_minute_candles: [],
    last_manage_minute_fetch_ms: 0,
    peak_protect_armed: false,
    last_1m_profit_exit_key: '',
    entry_watch: null,
    exit_deal_fails: 0,
    cycle_busy: false,
    cycle_busy_since: 0,
    pending_entry: null,
    entry_close_latch: null,
    hardinv_breach_since_ms: 0,
    ohlc_10s: publicOhlc10s(emptyTenSecState()),
  };

  const others = [...sessions.values()].filter((x) => x.running && x.id !== id).length;
  pushTick(session, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: null,
    detail: `ROBOT START · id=${id} · ${displayName} (${epic}) · lot ${lot} · ${acc.environment.toUpperCase()} · 10s OHLC from multi-feed consensus · ONE TRADE ONLY · other robots: ${others}`,
  });
  refreshEntryWatch(session, { last_reason: 'Started · lasa tirgu · meklē entry' });
  pushTick(session, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: null,
    detail: `ENTRY WATCH · ${session.entry_watch?.looking_for || 'UNKNOWN'}`,
  });
  pushTick(session, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: null,
    detail:
      'Rules: max 1 open · HardInv live · profit HOLD on 1m continue · reverse→PeakProtect 25% giveback · no late/stale entry blocks',
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
  /** Capital createdDate — required for TimeDecay after restart */
  entry_at?: string | null;
  deal_reference?: string | null;
  deal_id?: string | null;
  regime?: string | null;
  setup_type?: string | null;
}): Promise<RobotSession> {
  const id = robotIdFor(input.account_id, input.epic);
  const existing = sessions.get(id);
  if (existing?.running) {
    // Pipeline owns this fill — disable local entry brain so Admin + fanout never dual-arm
    existing.entry_enabled = false;
    existing.trading_enabled = true;
    existing.open_side = input.side;
    existing.mode = 'MANAGE';
    // Always take broker/pipeline fill price for HardInv/Peak/MFE (never keep stale mid/ref)
    if (input.entry_price != null && Number.isFinite(input.entry_price)) {
      if (existing.entry_price != null && existing.entry_price !== input.entry_price) {
        existing.mfe = 0;
        existing.mae = 0;
        existing.peak_retention = null;
      }
      existing.entry_price = input.entry_price;
      existing.peak_favorable = input.entry_price;
    } else if (existing.entry_price == null) {
      existing.entry_price = input.entry_price;
    }
    existing.entry_at = preferBrokerEntryAt(existing.entry_at, input.entry_at);
    if (input.deal_reference) existing.last_deal_reference = input.deal_reference;
    if (input.deal_id) existing.deal_id = input.deal_id;
    if (input.regime) existing.regime = normalizeRegime(input.regime);
    existing.orders_placed = Math.max(existing.orders_placed, 1);
    pushTick(existing, {
      phase: 'ORDER',
      bid: null,
      ask: null,
      mid: input.entry_price,
      detail: `PIPELINE FILL ${input.side} ${input.display_name} lot=${input.lot_size} · entry ${
        existing.entry_price ?? '—'
      } · since ${existing.entry_at || '—'} · ${existing.regime} · manage open · entry_brain=OFF · MFE ${existing.mfe.toFixed(5)}`,
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
    internal.entry_at = preferBrokerEntryAt(null, input.entry_at);
    internal.mode = 'MANAGE';
    internal.last_deal_reference = input.deal_reference || null;
    if (input.deal_id) internal.deal_id = input.deal_id;
    internal.orders_placed = Math.max(internal.orders_placed, 1);
    if (input.regime) internal.regime = normalizeRegime(input.regime);
    pushTick(internal, {
      phase: 'ORDER',
      bid: null,
      ask: null,
      mid: input.entry_price,
      detail: `PIPELINE FILL ${input.side} ${input.display_name} lot=${input.lot_size} · since ${
        internal.entry_at || '—'
      } · ${internal.regime} · manage-only attached`,
    });
  }
  return getRobotSession(session.id) || session;
}
