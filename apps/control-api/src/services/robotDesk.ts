import { pool } from '../db/pool.js';
import { decrypt } from '../security/encryption.js';
import {
  acquireCapitalSession,
  closeCapitalPosition,
  confirmCapitalDeal,
  createCapitalPosition,
  fetchCapitalHourPrices,
  fetchCapitalMarketQuote,
  fetchCapitalMinutePrices,
  fetchCapitalPrices,
  listCapitalOpenPositions,
  type CapitalMarketQuote,
  type CapitalOpenPosition,
  type CapitalSession,
} from './capitalCom.js';
import { emitToClient } from './clientEvents.js';
import { mapTradeType } from './tradePresentation.js';
import {
  observeClosedBars,
  normalizeRegime,
  type RegimeName,
} from './regimes.js';
import { decideBestOutcomeExit, favorableMove } from './exitManage.js';
import { scaleFromGold } from './instrumentScale.js';
import {
  playbookFromRegime,
  type Playbook,
  type TradePlaybook,
} from './playbooks.js';
import {
  buildStructure,
  decideEntryFromSetup,
  decideEntryFromTenSecMove,
  emptySetup,
  emptyStructure,
  playbookFromSetup,
  setupCatalog,
  updateSetupSticky,
  type MarketSetup,
  type StructureBook,
} from './marketSetup.js';
import {
  allowEntryFromFeeds,
  multiFeedOwnsOhlc,
  pickOhlcMid,
  readMultiFeedPrice,
  type MultiFeedPrice,
  type MultiFeedLeg,
} from './robotReader.js';
import {
  aggregateSecondsToTen,
  emptyTenSecState,
  publicOhlc10s,
  updateTenSecondOhlc,
  type TenSecBar,
  type TenSecState,
} from './tenSecondOhlc.js';

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
  playbook: Playbook | null;
  entry_setup: string | null;
  orders_placed: number;
  exits_done: number;
  reads_ok: number;
  reads_fail: number;
  open_side: 'BUY' | 'SELL' | null;
  safety_sl: number | null;
  error: string | null;
  /** When false, robot never invents entries — manage-only / legacy fanout attach */
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
  /** Swing structure + setup-first state */
  zones?: {
    ready: boolean;
    structure: string;
    high: number;
    low: number;
    bias: string;
    detail: string;
  } | null;
  market_setup?: {
    kind: string;
    side: string | null;
    status: string;
    playbook: string | null;
    reason: string;
    swing_high?: number;
    swing_low?: number;
    watch_buy?: string | null;
    watch_sell?: string | null;
  } | null;
  decision_chain?: {
    feeds: string;
    ohlc: string;
    regime: string;
    zones: string;
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
  last_multi_feed_ms: number;
  multiFeed: MultiFeedPrice | null;
  previous_regime: RegimeName;
  regime_age_bars: number;
  playbook_age_bars: number;
  playbook_watch: Playbook;
  /** Swing structure (1m + 1h) — durable levels */
  structureBook: StructureBook;
  /** Sticky setup — changes only on structure refresh, never every quote tick */
  marketSetup: MarketSetup;
  last_structure_fetch_ms: number;
  last_minute_candles: import('./capitalCom.js').CapitalPriceCandle[];
  /** Debounce Capital order spam between attempts */
  last_entry_attempt_ms: number;
  /** Last flat mid — diagnostics only */
  last_flat_mid: number | null;
  /** Last opened side — block opposite flip spam */
  last_entry_side: 'BUY' | 'SELL' | null;
  last_entry_side_ms: number;
  /** After HardInvalidation / thesis fail — longer flip lock */
  last_hard_exit_ms: number;
};

const STRUCTURE_REFRESH_MS = 10_000;
const STRUCTURE_MINUTE_BARS = 120;
const STRUCTURE_HOUR_BARS = 24;

const ACTIVE_CADENCE_MS = 2_000;
const CLOSED_MARKET_CADENCE_MS = 90_000;
const CLOSED_MARKET_TICK_EVERY_MS = 5 * 60_000;

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
  s.ticks.unshift({ ...tick, at: new Date().toISOString() });
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
    last_multi_feed_ms: _mf,
    multiFeed: _multi,
    previous_regime: _prevReg,
    regime_age_bars: _regAge,
    playbook_age_bars: _pbAge,
    playbook_watch: _pbWatch,
    structureBook: _structureBook,
    marketSetup: _marketSetup,
    last_structure_fetch_ms: _structAt,
    last_minute_candles: _mins,
    last_entry_attempt_ms: _entryAt,
    last_flat_mid: _flatMid,
    last_entry_side: _entrySide,
    last_entry_side_ms: _entrySideAt,
    last_hard_exit_ms: _hardExit,
    ...rest
  } = s;
  const st = s.structureBook;
  const setup = s.marketSetup;
  return {
    ...rest,
    ohlc_10s: publicOhlc10s(s.ohlcState),
    feed_source: rest.feed_source,
    feed_contributing: s.multiFeed?.contributing ?? rest.feed_contributing ?? 0,
    feed_sender_count: s.multiFeed?.sender_count ?? rest.feed_sender_count ?? 0,
    feed_agreement: s.multiFeed?.agreement ?? rest.feed_agreement ?? null,
    feed_legs: s.multiFeed?.legs ?? rest.feed_legs ?? [],
    zones: {
      ready: st.ready,
      structure: setup.kind === 'NONE' ? 'NONE' : setup.kind,
      high: st.swing_high,
      low: st.swing_low,
      bias: st.bias,
      detail: st.detail,
    },
    market_setup: {
      kind: setup.kind,
      side: setup.side,
      status: setup.status,
      playbook: setup.playbook,
      reason: setup.reason,
      swing_high: setup.swing_high || st.swing_high,
      swing_low: setup.swing_low || st.swing_low,
      watch_buy: setup.watch_buy ?? null,
      watch_sell: setup.watch_sell ?? null,
    },
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
  const setup = s.marketSetup;
  let action = 'NONE';
  if (!s.running) action = 'STOPPED';
  else if (s.open_side) action = `BEST_OUTCOME ${s.open_side}`;
  else if (setup.status === 'ARMED') action = `ARMED ${setup.side || ''}`.trim();
  else if (setup.status === 'FORMING') action = `FORMING ${setup.kind}`;
  else if (s.mode === 'ENTRY') action = 'SCAN';
  const st = s.structureBook;
  const zonesLine = st.ready
    ? `swing H${st.swing_high.toFixed(2)}/L${st.swing_low.toFixed(2)}`
    : st.detail || 'SEEDING';
  return {
    feeds,
    ohlc: ohlcLine,
    regime: `diag ${s.regime || 'RANGE'}`,
    zones: zonesLine,
    setup: `${setup.kind}/${setup.status}${setup.side ? ` ${setup.side}` : ''}`,
    action,
  };
}

/** Capital 1m + 1h → swing structure → sticky setup. Never on every quote tick alone. */
async function refreshStructureAndSetup(
  session: CapitalSession,
  s: Internal,
  mid: number | null,
  force = false
): Promise<void> {
  const now = Date.now();
  if (
    !force &&
    s.structureBook.ready &&
    now - s.last_structure_fetch_ms < STRUCTURE_REFRESH_MS
  ) {
    // Price left the swing band — refresh early so impulse flip is not 20s late
    const drifted =
      mid != null &&
      (mid > s.structureBook.swing_high + Math.max(s.structureBook.span * 0.15, 1.2) ||
        mid < s.structureBook.swing_low - Math.max(s.structureBook.span * 0.15, 1.2));
    if (!drifted) return;
  }
  const [hist, hours] = await Promise.all([
    fetchCapitalMinutePrices(session, s.epic, STRUCTURE_MINUTE_BARS),
    fetchCapitalHourPrices(session, s.epic, STRUCTURE_HOUR_BARS),
  ]);
  s.last_structure_fetch_ms = now;
  if (!hist.ok || !hist.candles.length) {
    if (!s.structureBook.ready) {
      s.structureBook = emptyStructure(hist.detail || 'minute history unavailable');
      s.marketSetup = emptySetup('structure unavailable');
    }
    return;
  }
  s.last_minute_candles = hist.candles;
  s.structureBook = buildStructure({
    minutes: hist.candles,
    hours: hours.ok ? hours.candles : null,
    mid,
    prev: s.structureBook.ready ? s.structureBook : null,
  });
  // Setup sticky update only here (structure cadence) — not every 2s quote
  if (!s.open_side) {
    s.marketSetup = updateSetupSticky(s.marketSetup, s.structureBook, hist.candles);
    const pb = playbookFromSetup(s.marketSetup);
    if (pb) {
      s.playbook = pb;
      s.playbook_watch = pb;
    } else if (s.marketSetup.kind === 'NONE') {
      s.playbook = null;
      s.playbook_watch = 'WAIT';
    }
    s.entry_setup = s.marketSetup.kind === 'NONE' ? null : s.marketSetup.kind;
  }
}

export function robotBoardMeta(sessions: RobotSession[]) {
  const activeSetups = [
    ...new Set(
      sessions
        .filter((s) => s.running)
        .map((s) => s.market_setup?.kind || s.entry_setup || 'NONE')
    ),
  ];
  const maxFeeds = sessions.reduce(
    (n, s) => Math.max(n, s.feed_sender_count || 0, s.feed_legs?.length || 0),
    0
  );
  const contributing = sessions.reduce((n, s) => Math.max(n, s.feed_contributing || 0), 0);
  return {
    regimes: setupCatalog().map((x) => x.name),
    trade_types: ['BUY LONG', 'SELL LONG', 'BUY SCALP', 'SELL SCALP', 'BUY FADE', 'SELL FADE'],
    active_regimes: activeSetups,
    feed_sender_count: maxFeeds,
    feed_contributing: contributing,
    chain: 'Capital 1h+1m+10s → STRUCTURE(swing) → SETUP(sticky) → ENTRY(closed 10s) → BEST OUTCOME',
    note:
      'Setup-first: NONE only when quiet. CONTINUATION/PULLBACK/FADE bounce rides rally (tp≥3–4pt, not +£0.07 scalp). Entry on closed 10s confirm.',
  };
}

function applyRobotRegime(s: Internal, bars?: TenSecBar[]) {
  // Diagnostic 10s label only — NEVER drives playbook/setup/entry
  const incoming = bars?.length
    ? bars
    : s.ohlcState.last_closed
      ? [s.ohlcState.last_closed]
      : [];
  if (incoming.length) {
    const snap = observeClosedBars(s.epic, incoming, s.display_name, s.id);
    const next = snap.current;
    if (next === s.regime) {
      s.regime_age_bars += Math.max(1, incoming.length);
    } else {
      s.previous_regime = s.regime;
      s.regime = next;
      s.regime_age_bars = 1;
    }
    if (bars?.length) s.closedBars = bars.slice(-24);
    else if (s.ohlcState.last_closed) {
      const last = s.ohlcState.last_closed;
      const prev = s.closedBars[s.closedBars.length - 1];
      const same =
        prev &&
        Math.abs(prev.open - last.open) < 1e-9 &&
        Math.abs(prev.close - last.close) < 1e-9;
      if (!same) {
        s.closedBars.push(last);
        if (s.closedBars.length > 24) s.closedBars = s.closedBars.slice(-24);
      }
    }
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
  s.playbook = null;
  s.entry_setup = null;
  s.mode = 'FLAT';
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

/** True when this account already runs its own entry brain (not manage-only / not fanout). */
export function hasRunningEntryBrain(accountId: number, epic?: string | null): boolean {
  const want = epic ? String(epic).trim().toLowerCase() : null;
  for (const s of sessions.values()) {
    if (!s.running || !s.entry_enabled || s.account_id !== accountId) continue;
    if (want && s.epic.trim().toLowerCase() !== want) continue;
    return true;
  }
  return false;
}

/** Stop only entry brains — never kill a manage-only robot sitting on an open trade. */
export async function stopEntryRobotsForAccount(accountId: number): Promise<void> {
  for (const s of [...sessions.values()]) {
    if (s.account_id === accountId && s.running && s.entry_enabled) {
      await stopRobotSession(s.id);
    }
  }
}

/**
 * One account = one live market. Starting EURUSD must not leave a Kimly (or any other epic)
 * robot running on the same account. Manage-only with an OPEN trade is left alone.
 */
export async function stopOtherRobotsForAccount(
  accountId: number,
  keepEpic: string
): Promise<string[]> {
  const keep = String(keepEpic || '').trim().toLowerCase();
  const stopped: string[] = [];
  for (const s of [...sessions.values()]) {
    if (s.account_id !== accountId || !s.running) continue;
    if (s.epic.trim().toLowerCase() === keep) continue;
    if (!s.entry_enabled && s.open_side) continue;
    await stopRobotSession(s.id);
    stopped.push(`${s.display_name} (${s.epic})`);
  }
  return stopped;
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
  s.stopped_at = new Date().toISOString();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
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
  const pub = publicSession(s);
  if (!s.running && !s.open_side) sessions.delete(s.id);
  return pub;
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
  if (/HardInvalidation|ThesisFailure|thesis/i.test(reason)) {
    s.last_hard_exit_ms = Date.now();
  }
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
      trade_type: mapTradeType(s.open_side, s.entry_setup, s.regime),
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
  setupType?: string | null,
  playbook?: TradePlaybook | null
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
      if (!s.playbook || s.playbook === 'WAIT') {
        s.playbook = playbookFromRegime(s.regime);
        if (s.playbook === 'WAIT') s.playbook = 'SCALP';
      }
      s.mode = 'MANAGE';
      if (existing.stop_level != null) s.safety_sl = existing.stop_level;
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `ONE TRADE ONLY — broker already open ${existing.direction} dealId=${existing.deal_id} · no new entry`,
      });
      return;
    }
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
    pushTick(s, {
      phase: 'WAIT',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `Safety SL not accepted — entry without SL (${result?.detail || 'unknown'})`,
    });
    result = await createCapitalPosition(session, {
      epic: s.epic,
      direction,
      size: s.lot_size,
    });
    stopLevel = null;
    usedStopDistance = null;
  }

  if (!result.ok) {
    s.error = result.detail;
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `ORDER FAIL ${direction}: ${result.detail}`,
    });
    return;
  }

  s.orders_placed += 1;
  s.open_side = direction;
  s.playbook = playbook || playbookFromRegime(s.regime);
  if (s.playbook === 'WAIT') s.playbook = 'SCALP';
  s.entry_setup = setupType || null;
  s.mode = 'MANAGE';
  s.last_deal_reference = result.deal_reference || null;
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

  // Prefer broker-reported stopLevel when available
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
    detail: `ORDER ENTRY ${direction} ${s.display_name} lot=${s.lot_size} · SL ${
      s.safety_sl ?? 'none'
    }${usedStopDistance != null ? ` (dist ${usedStopDistance}pts)` : ''} · ${result.detail}${
      dealId ? ` · dealId=${dealId}` : ''
    }`,
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
  if (!opened.ok) {
    s.reads_fail += 1;
    s.error = opened.result.detail;
    const rateLimited =
      opened.result.status === 429 || /rate-limit|too-many|cooldown/i.test(opened.result.detail);
    pushTick(s, {
      phase: rateLimited ? 'WAIT' : 'ERROR',
      bid: null,
      ask: null,
      mid: null,
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

    // Market closed / offline → park: no positions sync, no MANAGE, no entry (anti-spam Capital)
    if (!marketAllowsTrading(quote.market_status)) {
      setRobotCadence(s, CLOSED_MARKET_CADENCE_MS);
      const now = Date.now();
      if (now - s.last_market_closed_tick_ms >= CLOSED_MARKET_TICK_EVERY_MS) {
        s.last_market_closed_tick_ms = now;
        pushTick(s, {
          phase: 'WAIT',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `MARKET ${quote.market_status || 'CLOSED'} — park robot (no manage / no entry / no position spam) · poll ${
            CLOSED_MARKET_CADENCE_MS / 1000
          }s until TRADEABLE`,
        });
      }
      return;
    }

    // Restore normal cadence after a successful tradeable read (may have been slowed by 429 / closed)
    setRobotCadence(s, ACTIVE_CADENCE_MS);
    s.last_mid = quote.mid;

    // Multi-provider read (Capital + public near Capital). Throttle to protect Capital API.
    if (Date.now() - s.last_multi_feed_ms >= 4_000) {
      s.last_multi_feed_ms = Date.now();
      try {
        s.multiFeed = await readMultiFeedPrice(s.epic, {
          anchorMid: quote.mid,
          connectionId: s.connection_id,
        });
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

    // OHLC always from Capital-safe mid (LOCAL Capital quote if public is far)
    const ohlcMid = picked.mid ?? quote.mid;
    if (ohlcMid != null) {
      s.ohlcState = updateTenSecondOhlc(s.ohlcState, ohlcMid, Date.now());
      s.ohlc_10s = publicOhlc10s(s.ohlcState);
      if (s.ohlcState.just_closed && s.ohlcState.last_closed) {
        applyRobotRegime(s, [s.ohlcState.last_closed]);
      }
    }

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
        if (!s.playbook || s.playbook === 'WAIT') {
          s.playbook = playbookFromRegime(s.regime);
          if (s.playbook === 'WAIT') s.playbook = 'SCALP';
        }
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
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `Position sync warn: ${listed.detail} · holding ONE TRADE rule (no new entry if unsure)`,
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
      } · UPL=${s.unrealized != null ? s.unrealized.toFixed(5) : '—'} · MFE=${s.mfe.toFixed(5)}`,
    });

    if (!s.trading_enabled) {
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: 'Trading OFF — reading only',
      });
      return;
    }

    // ——— MANAGE open trade: never send entry ———
    if (s.open_side || brokerOpen) {
      s.mode = 'MANAGE';
      if (quote.mid == null) return;

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
        detail: `ONE TRADE · manage ${s.open_side} · ${s.playbook || '?'} · ${s.regime} · UPL ${
          s.unrealized != null ? s.unrealized.toFixed(5) : '—'
        } · MFE ${s.mfe.toFixed(5)} · MAE ${s.mae.toFixed(5)} · ret ${
          s.peak_retention != null ? `${(s.peak_retention * 100).toFixed(0)}%` : '—'
        } · no new orders`,
      });
      return;
    }

    // ——— FLAT: entry only after close (and only if entry_enabled) ———
    if (!s.entry_enabled) {
      s.mode = s.open_side ? 'MANAGE' : 'FLAT';
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

    // After close: 1×10s bar pause; after HardInv — brief lock
    const hardAgo = s.last_hard_exit_ms > 0 ? Date.now() - s.last_hard_exit_ms : Infinity;
    const POST_CLOSE_COOLDOWN_MS = hardAgo < 180_000 ? 25_000 : 10_000;
    const sinceClose = Date.now() - (s.closed_at_ms || 0);
    if (s.closed_at_ms > 0 && sinceClose < POST_CLOSE_COOLDOWN_MS) {
      pushTick(s, {
        phase: 'INFO',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `cooldown ${Math.ceil((POST_CLOSE_COOLDOWN_MS - sinceClose) / 1000)}s after close${
          hardAgo < 180_000 ? ' · hard-exit lock' : ''
        }`,
      });
      return;
    }

    if (quote.mid == null) return;

    // Seed SECOND→10s when multi-feed does not own OHLC
    if (!multiFeedOwnsOhlc(s.multiFeed) && Date.now() - s.last_second_fetch_ms >= 8_000) {
      s.last_second_fetch_ms = Date.now();
      const sec = await fetchCapitalPrices(opened.session, s.epic, 'SECOND', 40);
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
          if (isNew) {
            s.last_closed_bar_key = key;
            s.ohlc_10s = publicOhlc10s(s.ohlcState);
            applyRobotRegime(s, bars);
          } else {
            s.ohlc_10s = publicOhlc10s(s.ohlcState);
          }
        }
      }
    }

    const feedGate = allowEntryFromFeeds(s.multiFeed);
    if (!feedGate.ok) {
      pushTick(s, {
        phase: 'INFO',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `FEED NOTE · ${feedGate.reason}`,
      });
    }

    // Structure + sticky setup (1h+1m) — not every quote tick
    await refreshStructureAndSetup(
      opened.session,
      s,
      quote.mid,
      !s.structureBook.ready || s.ohlcState.just_closed
    );

    const bar = s.ohlcState.last_closed;
    const st = s.structureBook;
    const setup = s.marketSetup;
    const structLine = st.ready
      ? `swing H${st.swing_high.toFixed(2)}/L${st.swing_low.toFixed(2)}`
      : st.detail;
    const setupLine = `${setup.kind}/${setup.status}${setup.side ? ` ${setup.side}` : ''}`;
    const ohlcLine = bar
      ? `10s O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} · ${structLine} · ${setupLine}`
      : `10s seeding · ${structLine} · ${setupLine}`;

    if (quote.mid != null) s.last_flat_mid = quote.mid;

    // Need a just-closed 10s bar for any entry (setup confirm OR move-from-NONE)
    if (!s.ohlcState.just_closed || !bar) {
      const waitNote =
        setup.kind === 'NONE' || setup.status === 'NONE'
          ? `NONE · ${setup.reason}`
          : setup.status === 'FORMING'
            ? `FORMING · ${setup.reason}`
            : `ARMED · waiting closed 10s confirm`;
      pushTick(s, {
        phase: 'DECIDE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `${ohlcLine} · ${waitNote}`,
      });
      return;
    }

    let entry =
      setup.kind !== 'NONE' && setup.status === 'ARMED'
        ? decideEntryFromSetup(setup, bar, s.last_minute_candles)
        : null;

    // Mid-swing NONE was starving every real 10s V-leg — trade the move (never against dump/rally)
    if (!entry && (setup.kind === 'NONE' || setup.status === 'NONE')) {
      entry = decideEntryFromTenSecMove(st, bar, s.last_minute_candles);
      if (!entry) {
        pushTick(s, {
          phase: 'DECIDE',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `${ohlcLine} · NONE · ${setup.reason}`,
        });
        return;
      }
    }

    if (setup.status === 'FORMING' && !entry) {
      pushTick(s, {
        phase: 'DECIDE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `${ohlcLine} · FORMING · ${setup.reason}`,
      });
      return;
    }

    if (!entry) {
      const tipNote =
        setup.side &&
        ((setup.side === 'BUY' &&
          st.ready &&
          bar.close >=
            st.swing_high -
            Math.max(st.span * 0.08, scaleFromGold(st.mid || quote.mid, 0.8))) ||
          (setup.side === 'SELL' &&
            st.ready &&
            bar.close <=
              st.swing_low +
              Math.max(st.span * 0.08, scaleFromGold(st.mid || quote.mid, 0.8))))
          ? ' · blocked tip-chase'
          : '';
      pushTick(s, {
        phase: 'DECIDE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `${ohlcLine} · ARMED · no 10s confirm yet${tipNote} · ${setup.reason}`,
      });
      return;
    }

    // Opposite-side lock: brief for 10s V-flips; longer only after HardInv
    const hardRecent = s.last_hard_exit_ms > 0 && Date.now() - s.last_hard_exit_ms < 300_000;
    const SIDE_LOCK_MS = hardRecent ? 45_000 : 20_000;
    if (
      s.last_entry_side &&
      s.last_entry_side !== entry.direction &&
      Date.now() - s.last_entry_side_ms < SIDE_LOCK_MS
    ) {
      pushTick(s, {
        phase: 'INFO',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `${ohlcLine} · side-lock ${s.last_entry_side} ${Math.ceil(
          (SIDE_LOCK_MS - (Date.now() - s.last_entry_side_ms)) / 1000
        )}s · no flip to ${entry.direction}${hardRecent ? ' · after hard exit' : ''}`,
      });
      return;
    }

    const direction = entry.direction;
    const setupType = entry.setup;
    const entryPlaybook = entry.playbook;
    const reason = entry.reason;
    s.playbook = entryPlaybook;
    s.entry_setup = setupType;

    s.last_entry_attempt_ms = Date.now();
    s.last_entry_side = direction;
    s.last_entry_side_ms = Date.now();
    pushTick(s, {
      phase: 'ORDER',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `${ohlcLine} · OPEN ${direction} · ${reason}`,
    });
    await enterTrade(opened.session, s, direction, quote, reason, setupType, entryPlaybook);
    return;
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

  const dropped = await stopOtherRobotsForAccount(acc.id, epic);

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
    last_multi_feed_ms: 0,
    multiFeed: null,
    feed_source: 'NONE',
    feed_contributing: 0,
    feed_sender_count: 0,
    feed_agreement: null,
    regime: 'RANGE',
    playbook: null,
    entry_setup: null,
    previous_regime: 'RANGE',
    regime_age_bars: 0,
    playbook_age_bars: 0,
    playbook_watch: 'WAIT',
    structureBook: emptyStructure('awaiting minute+hour history'),
    marketSetup: emptySetup('awaiting structure'),
    last_structure_fetch_ms: 0,
    last_minute_candles: [],
    last_entry_attempt_ms: 0,
    last_flat_mid: null,
    last_entry_side: null,
    last_entry_side_ms: 0,
    last_hard_exit_ms: 0,

    ohlc_10s: publicOhlc10s(emptyTenSecState()),
  };

  pushTick(session, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: null,
    detail: `ROBOT START · id=${id} · ${displayName} (${epic}) · lot ${lot} · ${acc.environment.toUpperCase()} · OWN BRAIN · client=${acc.client_name}${
      dropped.length ? ` · stopped other markets: ${dropped.join(', ')}` : ''
    }`,
  });
  pushTick(session, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: null,
    detail:
      'Rules: this client alone — structure(1h+1m) → sticky SETUP → closed 10s entry → BEST OUTCOME · never shared Market Core fanout',
  });

  sessions.set(id, session);
  // Own entry brain owns this account — leave Market Core fanout so clients never share one signal
  if (session.entry_enabled) {
    void pool
      .query(
        `UPDATE account_instrument_settings
         SET trading_enabled = false, updated_at = NOW()
         WHERE broker_account_id = $1`,
        [acc.id]
      )
      .catch(() => undefined);
  }
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
    existing.playbook =
      (input as { playbook?: TradePlaybook | null }).playbook ||
      playbookFromRegime(input.regime) ||
      'SCALP';
    if (input.setup_type) existing.entry_setup = String(input.setup_type);
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
    internal.playbook = playbookFromRegime(input.regime);
    if (internal.playbook === 'WAIT') internal.playbook = 'SCALP';
    if (input.setup_type) internal.entry_setup = String(input.setup_type);
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
