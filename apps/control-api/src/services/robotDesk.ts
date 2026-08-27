import { pool } from '../db/pool.js';
import { decrypt } from '../security/encryption.js';
import {
  acquireCapitalSession,
  closeCapitalPosition,
  confirmCapitalDeal,
  createCapitalPosition,
  fetchCapitalMarketQuote,
  fetchCapitalPrices,
  fetchCapitalConfirmedProfit,
  listCapitalOpenPositions,
  ensureCapitalStopVisible,
  type CapitalMarketQuote,
  type CapitalOpenPosition,
  type CapitalSession,
} from './capitalCom.js';
import { emitToClient } from './clientEvents.js';
import {
  listDesiredRunningRobots,
  markRobotDesiredRunning,
  markRobotDesiredStopped,
} from './robotDeskPersist.js';
import { mapTradeType } from './tradePresentation.js';
import {
  observeClosedBars,
  normalizeRegime,
  currentRegime,
  MAX_REGIME_BARS,
  toLiveRegime,
  type RegimeName,
} from './regimes.js';
import { decideBestOutcomeExit, describeBestOutcomeState, favorableMove, manageExitPrice } from './exitManage.js';
import { SAFETY_SL_PCT } from './microScalpThresholds.js';
import {
  buildScalpZone,
  continuationSameSide,
  decideEntryFrom10sRegime,
  explainNoEntry,
  formatZoneInfo,
  shortNetMove,
  tapeSide,
  aggregateTenSecToFiveMin,
  idleArmedState,
} from './entryFromRegime.js';
import type { ScalpZone } from './zones.js';
import { noteEpicTradeClose, allowEpicReentry } from './tradeCooldown.js';
import { deskConflictShouldExit, deskOpensOnEpic } from './deskSideLock.js';
import {
  allowEntryFromFeeds,
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
import {
  appendClosedTrade,
  appendOpenEvent,
  newTradeId,
  tradeJournalPath,
  type JournalOpenSnap,
} from './tradeJournal.js';
import { allowEntryFromDataQuality } from './dataQuality.js';
import { atrWilder } from './volatilityNorm.js';
import { analysisMid } from './analysisPrice.js';
import { analyzeMarketStructure } from './marketStructure.js';
import {
  noteRiskTradeOpen,
  noteRiskTradePnl,
  allowRiskEntry,
  hydrateRiskState,
  exportRiskState,
  type PersistedRiskState,
} from './riskWindow.js';
import {
  buildBoStateFromOpen,
  clearBoState,
  clearPendingExecution,
  loadBoState,
  loadPendingExecution,
  nextClosePhaseAfterBrokerAck,
  nextClosePhaseAfterListFailure,
  recoverPendingExecution,
  resolveEntryPrice,
  saveBoState,
  savePendingExecution,
  shouldClearTradeState,
  shouldRetryClose,
  persistRiskSnapshotJson,
  canClearPendingExecution,
  type ClosePhase,
} from './tradeRecovery.js';
import {
  referenceAgreement,
  tagConfirmationQuote,
  tagExecutionQuote,
} from './multiFeedRoles.js';
import { detectStaleQuoteAdverse } from './staleQuoteGuard.js';
import {
  emptyMultiTfState,
  buildHtfContextFromBooks,
  type MultiTfState,
} from './timeframeBooks.js';
import { seedMultiTfHistory, refreshDueTfBooks } from './seedMultiTf.js';
import { computeInstrumentSafetyStop } from './safetyStop.js';
import { loadJson } from './persistentStore.js';
import { buildLiveEntryPlan, refreshArmedTriggerState, formatArmedTriggerDiag, type EntryPlan } from './entryPlan.js';

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
  orders_placed: number;
  exits_done: number;
  reads_ok: number;
  reads_fail: number;
  open_side: 'BUY' | 'SELL' | null;
  safety_sl: number | null;
  /** Soft 5m structural invalidation (software BO) — separate from Capital Safety SL */
  structural_sl: number | null;
  /** Favorable-distance target beyond 1R (swing/liquidity) for continuation hold */
  structure_target: number | null;
  atr_5m: number | null;
  /** RiskWindow trade counter already noted for this open (exactly once) */
  risk_open_noted: boolean;
  close_phase: ClosePhase;
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
  /** Live scalp zone snapshot for INFO */
  zone_info?: string | null;
  /** Regime context with bar counts — separate from zone */
  regime_info?: string | null;
  zone_high?: number | null;
  zone_low?: number | null;
  zone_kind?: string | null;
  /** Capital.com marketStatus snapshot — TRADEABLE vs CLOSED/OFFLINE */
  market_status?: string | null;
  market_tradeable?: boolean;
  market_info?: string | null;
  /** Live multi-TF tape for desk UI — never WAIT ENTRY · TRANSITION */
  tape_dir?: 'BUY' | 'SELL' | null;
  tape_reason?: string | null;
  decision_chain?: {
    feeds: string;
    ohlc: string;
    regime: string;
    setup: string | null;
    action: string;
  };
  /** Live ENTRY plan — WHERE/WHY/WAIT before fill (MAIN screen) */
  entry_plan?: EntryPlan | null;
};

type Internal = RobotSession & {
  timer: ReturnType<typeof setInterval> | null;
  connection_id: number;
  closed_at_ms: number;
  peak_favorable: number;
  /** Last Capital marketStatus — detect open→closed transitions */
  last_market_tradeable: boolean;
  /** Last time we logged "market closed" (throttle ticks) */
  last_market_closed_tick_ms: number;
  cadence_ms: number;
  ohlcState: TenSecState;
  last_second_fetch_ms: number;
  last_closed_bar_key: string;
  /** Last entry signal fingerprint — avoid re-firing same candle body every tick */
  last_entry_signal_key: string;
  closedBars: TenSecBar[];
  last_multi_feed_ms: number;
  multiFeed: MultiFeedPrice | null;
  cycle_busy: boolean;
  /** Pending Excel journal row until close */
  journal_open: JournalOpenSnap | null;
  pending_deal_reference: string | null;
  /** Capital-native multi-TF historical books */
  multiTf: MultiTfState;
  last_multi_tf_seed_ms: number;
  last_quote_fetch_ms: number;
  /** Stateful early ENTRY: SETUP→ARMED→TRIGGERED|INVALIDATED */
  armed_trigger: import('./earlyEntryArmed.js').ArmedTriggerState;
};

const ACTIVE_CADENCE_MS = 2_000;
const MANAGE_CADENCE_MS = 500;
const CLOSED_MARKET_CADENCE_MS = 15_000;
const CLOSED_MARKET_TICK_EVERY_MS = 15_000;

function marketAllowsTrading(status: string | null | undefined): boolean {
  const s = String(status || '')
    .trim()
    .toUpperCase();
  // Missing/unknown status → NO NEW ENTRY (#17)
  if (!s) return false;
  return s === 'TRADEABLE' || s === 'OPEN';
}

/** Exported for tests (#52). */
export { marketAllowsTrading };

/** Human INFO line — must scream when Capital market is not TRADEABLE (#136 / Aug13). */
export function formatMarketInfo(
  status: string | null | undefined,
  tradeable: boolean,
  pollSec = CLOSED_MARKET_CADENCE_MS / 1000
): string {
  const raw = String(status || '').trim().toUpperCase();
  const st = raw || 'UNKNOWN';
  if (tradeable) {
    return `MARKET OPEN · Capital=${st} · entry/manage allowed`;
  }
  return `MARKET CLOSED · Capital=${st} · app chart/prices can still move · NO orders until TRADEABLE · robot PARKED · poll ${pollSec}s`;
}

function setRobotCadence(s: Internal, ms: number) {
  if (s.timer && s.cadence_ms === ms) return;
  if (s.timer) clearInterval(s.timer);
  s.cadence_ms = ms;
  s.timer = setInterval(() => void robotCycle(s), ms);
}

/** After one client exits, nudge same-client manage only — no cross-client OHLC share. */
function kickPeerManageCycles(exceptId: string, epic: string) {
  const want = epic.trim().toLowerCase();
  const self = sessions.get(exceptId);
  const clientId = self?.client_id;
  for (const peer of sessions.values()) {
    if (peer.id === exceptId || !peer.running || !peer.open_side) continue;
    if (peer.epic.trim().toLowerCase() !== want) continue;
    // Same client only (multi-account same person) — never other clients' OHLC/feed
    if (clientId != null && peer.client_id !== clientId) continue;
    if (peer.cycle_busy) continue;
    void robotCycle(peer);
  }
}

/**
 * Per-client 10s OHLC — never fanout bars to other clients (disabled).
 */
void 0;

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
    last_entry_signal_key: _sig,
    closedBars: _bars,
    last_multi_feed_ms: _mf,
    multiFeed: _multi,
    cycle_busy: _busy,
    journal_open: _journal,
    pending_deal_reference: _pend,
    multiTf: _mtf,
    last_multi_tf_seed_ms: _mtfs,
    last_quote_fetch_ms: _lqf,
    ...rest
  } = s;
  const zoneSnap = buildScalpZone(s.closedBars);
  const liveBar = s.ohlcState.forming ?? s.ohlcState.last_closed;
  const tape = tapeSide(s.closedBars, liveBar);
  // Display regime from tape — never sticky TRANSITION/UNKNOWN on the board
  const displayRegime =
    tape.dir === 'BUY' ? 'TREND_UP' : tape.dir === 'SELL' ? 'TREND_DOWN' : 'RANGE';
  const entryPlan = buildLiveEntryPlan({
    price: s.last_mid,
    armed: s.armed_trigger,
    multiTf: s.multiTf,
    closedBars: s.closedBars,
    open_side: s.open_side,
    running: s.running,
  });
  return {
    ...rest,
    regime: displayRegime,
    ohlc_10s: publicOhlc10s(s.ohlcState),
    feed_source: rest.feed_source,
    feed_contributing: s.multiFeed?.contributing ?? rest.feed_contributing ?? 0,
    feed_sender_count: s.multiFeed?.sender_count ?? rest.feed_sender_count ?? 0,
    feed_agreement: s.multiFeed?.agreement ?? rest.feed_agreement ?? null,
    feed_legs: s.multiFeed?.legs ?? rest.feed_legs ?? [],
    zone_info: formatZoneInfo(zoneSnap, s.closedBars),
    regime_info: `TAPE ${tape.dir ?? 'FLAT'} · ${tape.reason}`,
    tape_dir: tape.dir,
    tape_reason: tape.reason,
    zone_high: zoneSnap?.high ?? null,
    zone_low: zoneSnap?.low ?? null,
    zone_kind: zoneSnap?.kind ?? null,
    market_status: s.market_status ?? null,
    market_tradeable: s.market_tradeable ?? true,
    market_info: formatMarketInfo(s.market_status, s.market_tradeable ?? true, s.cadence_ms / 1000),
    decision_chain: buildDecisionChain(s, tape, entryPlan),
    entry_plan: entryPlan,
  };
}

function buildDecisionChain(
  s: Internal,
  tape = tapeSide(s.closedBars, s.ohlcState.forming ?? s.ohlcState.last_closed),
  entryPlan?: EntryPlan | null
): NonNullable<RobotSession['decision_chain']> {
  const tradeable = s.market_tradeable ?? true;
  const marketLine = formatMarketInfo(s.market_status, tradeable, s.cadence_ms / 1000);
  if (!tradeable) {
    const mf = s.multiFeed;
    const capLive = mf?.capital_contributing ?? s.feed_contributing ?? 0;
    const capCfg = mf?.capital_sender_count ?? s.feed_sender_count ?? 0;
    return {
      feeds: `FEEDS cap ${capLive}/${capCfg} (warm while parked)`,
      ohlc: marketLine,
      regime: marketLine,
      setup: null,
      action: `PARKED · ${String(s.market_status || 'CLOSED').toUpperCase()}`,
    };
  }
  const ohlc = publicOhlc10s(s.ohlcState);
  const ohlcLine =
    ohlc.last_c != null
      ? `10s O${Number(ohlc.last_o).toFixed(2)}→C${Number(ohlc.last_c).toFixed(2)} ${ohlc.market}`
      : 'SEEDING';
  const zone = buildScalpZone(s.closedBars);
  const mf = s.multiFeed;
  const rejectN = (mf?.legs || []).filter((l) => l.role === 'REJECT').length;
  const capLive = mf?.capital_contributing ?? s.feed_contributing ?? 0;
  const capCfg = mf?.capital_sender_count ?? s.feed_sender_count ?? 0;
  const pubNear = mf?.public_contributing ?? 0;
  const feeds = `FEEDS cap ${capLive}/${capCfg} · pubAdv ${pubNear} · reject ${rejectN} · lead=${mf?.lead_label || '—'} · ${mf?.agreement || s.feed_agreement || 'NONE'}`.trim();
  const zoneLine = formatZoneInfo(zone, s.closedBars);
  let action = `SCAN · ${tape.reason}`;
  if (entryPlan && !s.open_side && s.running) {
    const bias = entryPlan.bias ?? '—';
    action = `ENTRY · ${entryPlan.state} · ${bias} · ${entryPlan.block_reason} · ${entryPlan.waiting_for}`;
  }
  if (!s.running) action = 'STOPPED';
  else if (s.open_side) action = `MANAGE ${s.open_side}`;
  else if (tape.dir === 'BUY') action = `READY BUY · ${tape.reason}`;
  else if (tape.dir === 'SELL') action = `READY SELL · ${tape.reason}`;
  return {
    feeds,
    ohlc: `${ohlcLine} · ${zoneLine}`,
    regime: `TAPE ${tape.dir ?? 'FLAT'} · ${tape.reason}`,
    setup: tape.dir,
    action,
  };
}

export function robotBoardMeta(sessions: RobotSession[]) {
  const activeTapes = [
    ...new Set(
      sessions
        .filter((s) => s.running)
        .map((s) => (s.tape_dir === 'BUY' ? 'TREND_UP' : s.tape_dir === 'SELL' ? 'TREND_DOWN' : 'RANGE'))
    ),
  ];
  const maxFeeds = sessions.reduce(
    (n, s) => Math.max(n, s.feed_sender_count || 0, s.feed_legs?.length || 0),
    0
  );
  const contributing = sessions.reduce((n, s) => Math.max(n, s.feed_contributing || 0), 0);
  return {
    regimes: ['TREND_UP', 'TREND_DOWN', 'RANGE'],
    trade_types: ['BUY', 'SELL'],
    active_regimes: activeTapes,
    feed_sender_count: maxFeeds,
    feed_contributing: contributing,
    chain: 'OWN Capital LEAD → own 10s OHLC → TAPE 5/1 → BUY|SELL · BO → EXIT',
    note:
      'Katram klientam savs Capital LEAD + savs 10s OHLC. Peer Capital / shared bars OFF. Public = ADVISORY only.',
  };
}

function formatScanContext(
  s: Internal,
  zone: ScalpZone | null,
  feedNote?: string
): string {
  const tape = tapeSide(s.closedBars, s.ohlcState.forming ?? s.ohlcState.last_closed);
  const tapeLine = `TAPE ${tape.dir ?? 'FLAT'} · ${tape.reason}`;
  const zoneLine = formatZoneInfo(zone, s.closedBars);
  const mf = s.multiFeed;
  const capLive = mf?.capital_contributing ?? s.feed_contributing ?? 0;
  const capCfg = mf?.capital_sender_count ?? s.feed_sender_count ?? 0;
  const feedLine =
    feedNote ||
    `FEEDS cap ${capLive}/${capCfg} · lead=${mf?.lead_label || '—'} · ${mf?.agreement || s.feed_agreement || 'NONE'}`;
  return `${tapeLine} · ${zoneLine} · ${feedLine}`;
}

function applyRobotRegime(s: Internal, bars?: TenSecBar[]) {
  const incoming = bars?.length
    ? bars
    : s.ohlcState.last_closed
      ? [s.ohlcState.last_closed]
      : [];
  if (incoming.length) {
    observeClosedBars(s.epic, incoming, s.display_name, s.client_id);
    for (const b of incoming) {
      const last = s.closedBars[s.closedBars.length - 1];
      if (last && last.open_time_ms === b.open_time_ms) {
        s.closedBars[s.closedBars.length - 1] = b;
        continue;
      }
      s.closedBars.push(b);
    }
    if (s.closedBars.length > MAX_REGIME_BARS) {
      s.closedBars = s.closedBars.slice(-MAX_REGIME_BARS);
    }
  }
  // Per-client book only — never sync from another client's epic book
  const own = currentRegime(s.epic, s.client_id);
  if (own) s.regime = toLiveRegime(own.current);
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
  s.structural_sl = null;
  s.structure_target = null;
  s.atr_5m = null;
  s.risk_open_noted = false;
  s.close_phase = 'CLOSED';
  s.mode = 'FLAT';
  s.journal_open = null;
  s.pending_deal_reference = null;
  // Consume armed fire — leaving ARMED+micro hot caused immediate re-entry loops.
  s.armed_trigger = idleArmedState();
  clearBoState(s.id);
  clearPendingExecution(s.id);
}

function persistBoFromSession(s: Internal) {
  if (!s.open_side || s.entry_price == null) return;
  saveBoState(
    buildBoStateFromOpen({
      deal_id: s.deal_id,
      side: s.open_side,
      entry_price: s.entry_price,
      entry_at: s.entry_at,
      mfe: s.mfe,
      mae: s.mae,
      peak_favorable: s.peak_favorable,
      peak_retention: s.peak_retention,
      structural_sl: s.structural_sl,
      safety_sl: s.safety_sl,
      structure_target: s.structure_target,
      close_phase: s.close_phase,
      pending_deal_reference: s.pending_deal_reference,
      epic: s.epic,
      account_id: s.account_id,
      robot_id: s.id,
    })
  );
}

function buildJournalOpen(
  s: Internal,
  direction: 'BUY' | 'SELL',
  reason: string,
  setupType: string | null | undefined,
  source: JournalOpenSnap['source']
): JournalOpenSnap {
  const zone = buildScalpZone(s.closedBars);
  const ohlc = publicOhlc10s(s.ohlcState);
  return {
    trade_id: newTradeId(source === 'pipeline' ? 'P' : 'D'),
    source,
    opened_at: s.entry_at || new Date().toISOString(),
    account_id: s.account_id,
    client_id: s.client_id,
    client_name: s.client_name,
    account_name: s.account_name,
    robot_id: s.id,
    environment: s.environment,
    epic: s.epic,
    display_name: s.display_name,
    side: direction,
    lot_size: s.lot_size,
    entry_price: s.entry_price,
    safety_sl: s.safety_sl,
    deal_id: s.deal_id,
    deal_reference: s.last_deal_reference,
    regime: String(s.regime || 'UNKNOWN'),
    setup_type: setupType ?? null,
    zone_kind: zone?.kind ?? null,
    zone_high: zone?.high ?? null,
    zone_low: zone?.low ?? null,
    zone_detail: zone ? zone.detail : formatZoneInfo(null, s.closedBars),
    open_reason: reason,
    feed_source: s.feed_source ?? s.multiFeed?.detail ?? null,
    feed_agreement: s.multiFeed?.agreement ?? s.feed_agreement ?? null,
    feed_contributing: s.multiFeed?.contributing ?? s.feed_contributing ?? null,
    feed_sender_count: s.multiFeed?.sender_count ?? s.feed_sender_count ?? null,
    lead_label: s.multiFeed?.lead_label ?? null,
    ohlc_last:
      ohlc.last_c != null
        ? `O${ohlc.last_o} H${ohlc.last_h} L${ohlc.last_l} C${ohlc.last_c} ${ohlc.market}`
        : null,
    entry_enabled: s.entry_enabled,
  };
}

function writeJournalClose(
  s: Internal,
  quote: Pick<CapitalMarketQuote, 'bid' | 'ask' | 'mid'>,
  reason: string,
  wasLoss: boolean
): void {
  const open = s.journal_open;
  if (!open) return;
  const exitMid = quote.mid;
  const exitPrice = exitMid;
  const pnlPts =
    open.entry_price != null && exitMid != null
      ? favorableMove(open.side, open.entry_price, exitMid)
      : null;
  const openedMs = Date.parse(open.opened_at);
  const hold_sec = Number.isFinite(openedMs)
    ? Math.max(0, Math.round((Date.now() - openedMs) / 1000))
    : 0;
  const zone = buildScalpZone(s.closedBars);
  const written = appendClosedTrade({
    open: {
      ...open,
      deal_id: s.deal_id || open.deal_id,
      safety_sl: s.safety_sl ?? open.safety_sl,
      entry_price: s.entry_price ?? open.entry_price,
    },
    closed_at: new Date().toISOString(),
    exit_price: exitPrice,
    exit_mid: exitMid,
    close_reason: reason,
    mfe: s.mfe,
    mae: s.mae,
    peak_retention: s.peak_retention,
    unrealized_at_close: s.unrealized,
    regime_at_exit: String(s.regime || 'UNKNOWN'),
    zone_detail_at_exit: formatZoneInfo(zone, s.closedBars),
    was_loss: wasLoss,
    hold_sec,
    pnl_pts: pnlPts,
  });
  pushTick(s, {
    phase: 'INFO',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: written.ok
      ? `EXCEL journal · ${written.path} · ${open.trade_id}`
      : written.detail,
  });
}

/**
 * SAFETY SL — instrument metadata only (#33/#34). No magnitude floors.
 */
function safetyStopLevel(
  direction: 'BUY' | 'SELL',
  mid: number,
  bid: number | null,
  ask: number | null,
  spread: number | null,
  minStopDistance: number | null,
  loosen = 1,
  meta?: { pointSize?: number | null; tickSize?: number | null }
): number | null {
  const r = computeInstrumentSafetyStop({
    direction,
    mid,
    bid,
    ask,
    spread,
    minStopDistance,
    pointSize: meta?.pointSize,
    tickSize: meta?.tickSize,
    loosen,
  });
  return r.ok ? r.stop_level : null;
}

/** Cushion stopDistance in Capital POINTS (≥ 1.5× min, ~0.08% when point size known). */
function safetyStopDistancePts(
  mid: number,
  minPts: number,
  pointSize: number | null
): number {
  const abs = Math.max(Math.abs(mid), 1e-9);
  const pct = abs * SAFETY_SL_PCT;
  let fromPct = minPts * 1.5;
  if (pointSize != null && pointSize > 0) {
    fromPct = Math.max(fromPct, pct / pointSize);
  }
  const distPts = Math.max(minPts * 1.5, fromPct, minPts + 1e-9);
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

/**
 * Track excursion in PRICE POINTS only.
 * Broker UPL ($) is display-only — never mix into MFE / peak_retention
 * or PeakProtection never arms (floor is in points).
 */
function updateExcursion(s: Internal, mid: number, brokerUpl?: number | null) {
  if (!s.open_side || s.entry_price == null) return;
  const fav = favorableMove(s.open_side, s.entry_price, mid);
  // Display UPL = Capital broker cash only — never invent from price fav
  s.unrealized =
    brokerUpl != null && Number.isFinite(brokerUpl) ? Number(brokerUpl) : null;
  if (fav > s.mfe) {
    s.mfe = fav;
    s.peak_favorable = mid;
  }
  if (fav < s.mae) s.mae = fav;
  s.peak_retention = s.mfe > 0 ? Math.max(0, fav / s.mfe) : null;
  persistBoFromSession(s);
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

/** Stop only entry brains — never kill a manage-only robot sitting on an open trade. */
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
  try {
    await markRobotDesiredStopped(id);
  } catch (err) {
    console.warn('[robot-desk] persist stop failed', err);
  }
  return publicSession(s);
}

function matchOpenOnEpic(
  positions: CapitalOpenPosition[],
  epic: string
): CapitalOpenPosition | null {
  const all = allOpensOnEpic(positions, epic);
  return all[0] || null;
}

function allOpensOnEpic(
  positions: CapitalOpenPosition[],
  epic: string
): CapitalOpenPosition[] {
  const want = epic.trim().toLowerCase();
  return positions.filter(
    (p) => p.epic.trim().toLowerCase() === want || p.deal_id === epic
  );
}

function isHedgedOpens(positions: CapitalOpenPosition[]): boolean {
  let buy = false;
  let sell = false;
  for (const p of positions) {
    if (p.direction === 'BUY') buy = true;
    if (p.direction === 'SELL') sell = true;
  }
  return buy && sell;
}

/** Close every broker deal on this epic (hedge / stacked junk). */
async function flattenBrokerOpensOnEpic(
  session: CapitalSession,
  s: Internal,
  quote: { bid: number | null; ask: number | null; mid: number | null },
  opens: CapitalOpenPosition[],
  reason: string
): Promise<void> {
  if (!opens.length) return;
  pushTick(s, {
    phase: 'DECIDE',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: `FLATTEN ${opens.length} deals on ${s.epic} · ${reason}`,
  });
  let anyLoss = false;
  let lastSide: 'BUY' | 'SELL' | null = null;
  for (const p of opens) {
    lastSide = p.direction;
    if (p.upl != null && p.upl < 0) anyLoss = true;
    const result = await closeCapitalPosition(session, p.deal_id);
    pushTick(s, {
      phase: result.ok ? 'EXIT' : 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: result.ok
        ? `CLOSED hedge ${p.direction} dealId=${p.deal_id} · ${result.detail}`
        : `CLOSE FAIL ${p.direction} ${p.deal_id}: ${result.detail}`,
    });
  }
  s.exits_done += 1;
  s.closed_at_ms = Date.now();
  noteEpicTradeClose(s.epic, lastSide, anyLoss);
  clearTradeState(s);
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
    s.close_phase = 'CLOSE_UNCERTAIN';
    return;
  }

  s.close_phase = 'CLOSE_REQUESTED';
  persistBoFromSession(s);

  pushTick(s, {
    phase: 'DECIDE',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: `EXIT NOW · CLOSE_REQUESTED · ${reason}`,
  });

  const result = await closeCapitalPosition(session, dealId);
  if (!result.ok) {
    s.error = result.detail;
    s.close_phase = 'CLOSE_UNCERTAIN';
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `CLOSE FAIL: ${result.detail} · state CLOSE_UNCERTAIN (not CLOSED)`,
    });
    return;
  }

  s.close_phase = 'BROKER_CLOSE_SENT';
  s.last_deal_reference = result.deal_reference || s.last_deal_reference;

  // Reconcile — HTTP ok is not CLOSED proof
  const listed = await listCapitalOpenPositions(session);
  let stillOpen = false;
  if (listed.ok) {
    stillOpen = allOpensOnEpic(listed.positions, s.epic).some(
      (p) => p.deal_id === dealId || p.deal_id === s.deal_id
    );
  } else {
    s.close_phase = 'RECONCILING';
    pushTick(s, {
      phase: 'WAIT',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `CLOSE sent · broker list fail — RECONCILING (not marking CLOSED) · ${listed.detail}`,
    });
    persistBoFromSession(s);
    s.mode = 'MANAGE';
    return;
  }

  const phase = nextClosePhaseAfterBrokerAck(stillOpen);
  s.close_phase = phase;
  if (stillOpen || !shouldClearTradeState(phase)) {
    pushTick(s, {
      phase: 'WAIT',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `CLOSE ok but broker still open dealId=${dealId} · CLOSE_UNCERTAIN · retry reconcile · keep management`,
    });
    persistBoFromSession(s);
    s.mode = 'MANAGE';
    return;
  }

  s.exits_done += 1;
  s.closed_at_ms = Date.now();
  const exitSide = s.open_side;
  // Broker-confirmed realized only — never invent wasLoss / PnL from UPL or mid
  const profitRef = result.deal_reference || s.last_deal_reference;
  const realizedGot = await fetchCapitalConfirmedProfit(session, profitRef);
  let wasLoss = false;
  if (realizedGot.ok && realizedGot.profit != null && Number.isFinite(realizedGot.profit)) {
    wasLoss = realizedGot.profit <= 0;
    noteRiskTradePnl(s.account_id, realizedGot.profit);
    pushTick(s, {
      phase: 'INFO',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `RISK PnL · broker realized ${realizedGot.profit} · ${realizedGot.detail}`,
    });
  } else {
    pushTick(s, {
      phase: 'INFO',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `RISK PnL UNKNOWN · skipped noteRiskTradePnl · ${realizedGot.detail}`,
    });
  }
  noteEpicTradeClose(s.epic, exitSide, wasLoss);
  s.error = null;
  writeJournalClose(s, quote, reason, wasLoss);
  pushTick(s, {
    phase: 'EXIT',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: `CLOSED ${s.open_side} ${s.display_name} · broker flat confirmed · ${result.detail} · ${reason}`,
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
  setupType?: string | null,
  structuralSl?: number | null
) {
  if (structuralSl != null && Number.isFinite(structuralSl)) {
    s.structural_sl = structuralSl;
  }

  // HARD RULE: never entry while any trade open on this epic
  const listed = await listCapitalOpenPositions(session);
  if (listed.ok) {
    const onEpic = allOpensOnEpic(listed.positions, s.epic);
    if (isHedgedOpens(onEpic) || onEpic.length > 1) {
      await flattenBrokerOpensOnEpic(
        session,
        s,
        quote,
        onEpic,
        'entry blocked — flatten hedge/stack first'
      );
      return;
    }
    const existing = onEpic[0] || null;
    if (existing) {
      s.open_side = existing.direction;
      s.deal_id = existing.deal_id;
      // Broker open_level only — never seed entry from quote.mid
      const fill = resolveEntryPrice({ broker_open_level: existing.open_level });
      if (fill != null) s.entry_price = fill;
      else {
        s.entry_price = null;
        pushTick(s, {
          phase: 'WAIT',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `ONE TRADE · broker open ${existing.direction} dealId=${existing.deal_id} · FILL UNKNOWN (no open_level)`,
        });
        return;
      }
      s.entry_at = s.entry_at || new Date().toISOString();
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

  // SAFETY SL — MUST be accepted by Capital and visible in Capital.com app.
  // Never open a naked position. Capital min-stop metadata required.
  const minPts = quote.min_stop_points;
  const minPrice = quote.min_stop_distance ?? null;
  const unit = (quote.min_stop_unit || 'POINTS').toUpperCase();
  const useDistance = minPts != null && minPts > 0 && !unit.includes('PERCENT');
  if (
    (minPts == null || minPts <= 0) &&
    (minPrice == null || minPrice <= 0)
  ) {
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: 'ENTRY BLOCKED — Capital minStop metadata UNKNOWN',
    });
    return;
  }
  const loosenSteps = [1, 1.15, 1.35, 1.6, 2.0, 2.5, 3.0];

  let stopLevel: number | null = null;
  let usedStopDistance: number | null = null;
  let result: Awaited<ReturnType<typeof createCapitalPosition>> | null = null;

  if (useDistance) {
    for (const loosen of loosenSteps) {
      const basePts = safetyStopDistancePts(mid, minPts!, quote.point_size ?? null);
      const distPts = Math.max(basePts * loosen, minPts! * Math.max(1.5, loosen));
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
        detail: `Capital SAFETY SL stopDistance=${stopDistance} pts (min=${minPts} · ~level ${
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
      if (!/stop|distance|validation|reject|attached|level|minimum/i.test(result.detail)) break;
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
        loosen,
        { pointSize: quote.point_size ?? null, tickSize: quote.point_size ?? null }
      );
      if (level == null) {
        pushTick(s, {
          phase: 'ERROR',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: 'ENTRY BLOCKED — Safety SL UNKNOWN (no tick/minStop metadata)',
        });
        return;
      }
      const dist = direction === 'BUY' ? mid - level : level - mid;
      pushTick(s, {
        phase: 'INFO',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `Capital SAFETY SL stopLevel=${level} (dist≈${dist.toFixed(5)} · minPrice=${
          minPrice ?? 'n/a'
        } · x${loosen})`,
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
      if (!/stop|distance|validation|reject|attached|level|minimum/i.test(result.detail)) break;
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
    s.error = result?.detail || 'SL required';
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `ENTRY BLOCKED — Capital rejected every Safety SL (no naked trade). ${
        result?.detail || ''
      }`,
    });
    return;
  }

  s.orders_placed += 1;
  s.open_side = direction;
  s.mode = 'FLAT'; // MANAGE only after broker fill confirmed (#25)
  s.close_phase = 'OPEN';
  s.last_deal_reference = result.deal_reference || null;
  s.pending_deal_reference = result.deal_reference || null;
  const signalMid = mid;
  s.entry_price = null; // never seed BO with signal mid
  s.entry_at = new Date().toISOString();
  s.mfe = 0;
  s.mae = 0;
  s.peak_favorable = mid;
  s.peak_retention = null;
  s.unrealized = 0;
  s.safety_sl = stopLevel != null && Number.isFinite(stopLevel) ? stopLevel : null;
  s.error = null;

  savePendingExecution({
    robot_id: s.id,
    account_id: s.account_id,
    epic: s.epic,
    side: direction,
    deal_reference: result.deal_reference || null,
    claimed_at: new Date().toISOString(),
    signal_mid: signalMid,
  });

  let confirmLevel: number | null = null;
  const dealId = await resolveDealId(session, s, result.deal_reference);
  if (dealId) s.deal_id = dealId;
  if (result.deal_reference) {
    const conf = await confirmCapitalDeal(session, result.deal_reference);
    if (conf.ok) {
      if (conf.deal_id) s.deal_id = conf.deal_id;
      if (conf.level != null) confirmLevel = conf.level;
    }
  }

  // Broker open_level = execution truth
  const listedAfter = await listCapitalOpenPositions(session);
  let brokerLevel: number | null = null;
  if (listedAfter.ok) {
    const hit = matchOpenOnEpic(listedAfter.positions, s.epic);
    if (hit) {
      s.deal_id = hit.deal_id;
      brokerLevel = hit.open_level;
      if (hit.stop_level != null) s.safety_sl = hit.stop_level;
    }
  }
  const fill = resolveEntryPrice({
    broker_open_level: brokerLevel,
    confirm_level: confirmLevel,
  });
  if (fill != null) {
    s.entry_price = fill;
    s.peak_favorable = fill;
    s.mode = 'MANAGE';
    // Setup consumed on fill — do not keep ARMED hot for a second fire.
    s.armed_trigger = idleArmedState();
    // Risk clock NOT here — wait until Safety SL visible
  } else {
    s.mode = 'FLAT';
    s.entry_price = null;
    pushTick(s, {
      phase: 'WAIT',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `FILL UNKNOWN · waiting broker open_level · signal mid ${signalMid} not used for BO`,
    });
  }
  if (brokerLevel != null && signalMid != null && Math.abs(brokerLevel - signalMid) > 1e-9) {
    pushTick(s, {
      phase: 'INFO',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `FILL · broker ${brokerLevel} vs signal mid ${signalMid} · slippage ${(brokerLevel - signalMid).toFixed(5)} · BO uses broker`,
    });
  }
  // #26 — clear pending only when broker position + fill confirmed
  if (
    canClearPendingExecution({
      brokerOpen: brokerLevel != null,
      fillLevel: fill,
    })
  ) {
    clearPendingExecution(s.id);
  }
  persistBoFromSession(s);

  if (fill == null) {
    return;
  }

  // Verify SL is physically on Capital.com — attach via PUT if missing
  const ensured = await ensureCapitalStopVisible(session, s.epic, {
    dealId: s.deal_id,
    stopDistance: usedStopDistance,
    stopLevel,
    minPts,
  });
  if (ensured.deal_id) s.deal_id = ensured.deal_id;

  if (ensured.ok && ensured.stop_level != null) {
    s.safety_sl = ensured.stop_level;
  }

  // Still no SL on Capital → close immediately (never leave naked)
  if (!ensured.ok || ensured.stop_level == null) {
    pushTick(s, {
      phase: 'ERROR',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `Capital.com shows NO SL — closing position (naked trade forbidden) · ${ensured.detail}`,
    });
    if (s.deal_id) {
      await closeCapitalPosition(session, s.deal_id);
    }
    clearTradeState(s);
    s.error = 'SL not visible on Capital.com — trade closed';
    return;
  }

  // Risk clock / trade counter — exactly once after broker fill AND Safety SL confirmed
  if (!s.risk_open_noted) {
    noteRiskTradeOpen(s.account_id);
    s.risk_open_noted = true;
  }
  persistBoFromSession(s);

  pushTick(s, {
    phase: 'INFO',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: ensured.detail,
  });

  pushTick(s, {
    phase: 'ORDER',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: `ORDER ENTRY ${direction} ${s.display_name} lot=${s.lot_size} · entry=${s.entry_price} (broker fill) · Capital Safety SL ${
      s.safety_sl
    } VISIBLE${usedStopDistance != null ? ` (dist ${usedStopDistance}pts)` : ''}${
      s.structural_sl != null ? ` · structSL ${s.structural_sl}` : ''
    } · ${result.detail}${
      dealId || s.deal_id ? ` · dealId=${s.deal_id || dealId}` : ''
    }`,
  });

  s.journal_open = buildJournalOpen(
    s,
    direction,
    reason,
    setupType ?? null,
    s.entry_enabled ? 'desk' : 'manage'
  );
  const openLog = appendOpenEvent(s.journal_open);
  pushTick(s, {
    phase: 'INFO',
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    detail: openLog.ok
      ? `EXCEL open-log · ${s.journal_open.trade_id} · close → ${tradeJournalPath()}`
      : openLog.detail,
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
      safety_sl: s.safety_sl,
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
        s.entry_price, // broker fill only — never quote.mid invent
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
  try {
    await robotCycleBody(s);
  } finally {
    s.cycle_busy = false;
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
    s.last_quote_fetch_ms = Date.now();
    if (quote.epic && quote.epic !== s.epic) {
      s.epic = quote.epic;
    }
    if (quote.mid != null) s.last_mid = quote.mid;

    s.market_status = quote.market_status;
    s.market_tradeable = marketAllowsTrading(quote.market_status);

    // Always refresh feeds (even when parked) — OWN Capital LEAD only
    if (Date.now() - s.last_multi_feed_ms >= 4_000) {
      s.last_multi_feed_ms = Date.now();
      try {
        s.multiFeed = await readMultiFeedPrice(s.epic, {
          anchorMid: quote.mid,
          connectionId: s.connection_id,
        });
      } catch {
        /* keep previous */
      }
    }
    // 10s OHLC from THIS client's Capital mid only — never peer blend
    const warmMid = quote.mid;
    s.feed_source = 'LOCAL';
    s.feed_contributing = warmMid != null ? 1 : s.multiFeed?.capital_contributing ?? 0;
    s.feed_sender_count = 1;
    s.feed_agreement = s.multiFeed?.agreement ?? 'INSUFFICIENT';
    if (warmMid != null) {
      s.ohlcState = updateTenSecondOhlc(s.ohlcState, warmMid, Date.now());
      s.ohlc_10s = publicOhlc10s(s.ohlcState);
      if (s.ohlcState.just_closed && s.ohlcState.last_closed) {
        applyRobotRegime(s, [s.ohlcState.last_closed]);
      }
    }

    // Market closed / offline → park: no positions sync, no MANAGE, no entry (anti-spam Capital)
    if (!s.market_tradeable) {
      setRobotCadence(s, CLOSED_MARKET_CADENCE_MS);
      const now = Date.now();
      const justClosed = s.last_market_tradeable && !s.market_tradeable;
      s.last_market_tradeable = false;
      const marketLine = formatMarketInfo(
        s.market_status,
        false,
        CLOSED_MARKET_CADENCE_MS / 1000
      );
      if (
        justClosed ||
        now - s.last_market_closed_tick_ms >= CLOSED_MARKET_TICK_EVERY_MS
      ) {
        s.last_market_closed_tick_ms = now;
        pushTick(s, {
          phase: justClosed ? 'INFO' : 'WAIT',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `${marketLine} · feeds cap ${s.feed_contributing ?? 0}/${s.feed_sender_count ?? 0} ${s.feed_source || 'LOCAL'}`,
        });
      }
      return;
    }

    s.last_market_tradeable = true;

    // Restore normal cadence after a successful tradeable read (may have been slowed by 429 / closed)
    setRobotCadence(s, s.open_side ? MANAGE_CADENCE_MS : ACTIVE_CADENCE_MS);

    // Sync truth from broker — source of ONE TRADE ONLY
    const listed = await listCapitalOpenPositions(opened.session);
    let brokerOpen: CapitalOpenPosition | null = null;
    if (listed.ok) {
      const onEpic = allOpensOnEpic(listed.positions, s.epic);
      // Hedge BUY+SELL on same epic → flatten immediately (Capital "same trade" mess)
      if (isHedgedOpens(onEpic)) {
        await flattenBrokerOpensOnEpic(
          opened.session,
          s,
          quote,
          onEpic,
          'HEDGE BUY+SELL on one epic — kill both'
        );
        queueMicrotask(() => kickPeerManageCycles(s.id, s.epic));
        return;
      }
      // Stacked same-side deals → keep one, close extras
      if (onEpic.length > 1) {
        const keep = onEpic[0]!;
        const extras = onEpic.slice(1);
        pushTick(s, {
          phase: 'DECIDE',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `STACKED ${onEpic.length}×${keep.direction} · keep ${keep.deal_id} · close ${extras.length} extras`,
        });
        for (const p of extras) {
          const result = await closeCapitalPosition(opened.session, p.deal_id);
          pushTick(s, {
            phase: result.ok ? 'EXIT' : 'ERROR',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: result.ok
              ? `CLOSED extra ${p.direction} ${p.deal_id}`
              : `CLOSE FAIL extra ${p.deal_id}: ${result.detail}`,
          });
        }
      }
      brokerOpen = onEpic[0] || null;
      if (brokerOpen) {
        const prior = loadBoState(s.id);
        s.open_side = brokerOpen.direction;
        s.deal_id = brokerOpen.deal_id;
        const fill = resolveEntryPrice({
          broker_open_level: brokerOpen.open_level,
        });
        if (fill != null) s.entry_price = fill;
        else if (s.entry_price == null && prior?.entry_price != null) {
          s.entry_price = prior.entry_price;
        }
        if (!s.entry_at) s.entry_at = prior?.entry_at || new Date().toISOString();
        if (prior) {
          s.mfe = Math.max(s.mfe, prior.mfe);
          s.mae = Math.min(s.mae, prior.mae);
          s.peak_favorable = prior.peak_favorable || s.peak_favorable;
          s.peak_retention = prior.peak_retention ?? s.peak_retention;
          if (s.structural_sl == null) s.structural_sl = prior.structural_sl;
          if (s.structure_target == null && prior.structure_target != null) {
            s.structure_target = prior.structure_target;
          }
        }
        if (brokerOpen.stop_level != null) s.safety_sl = brokerOpen.stop_level;
        s.mode = 'MANAGE';
        if (shouldRetryClose(s.close_phase)) {
          persistBoFromSession(s);
          setRobotCadence(s, MANAGE_CADENCE_MS);
          if (brokerOpen.upl != null) s.unrealized = brokerOpen.upl;
          await exitTrade(
            opened.session,
            s,
            quote,
            `CLOSE retry · phase ${s.close_phase} · broker still open`
          );
          return;
        }
        s.close_phase = 'OPEN';
        setRobotCadence(s, MANAGE_CADENCE_MS);
        if (brokerOpen.upl != null) s.unrealized = brokerOpen.upl;
        persistBoFromSession(s);

        // Pending execution recovery — never duplicate
        const pending = loadPendingExecution(s.id);
        const rec = recoverPendingExecution({
          pending,
          brokerOpen: {
            deal_id: brokerOpen.deal_id,
            direction: brokerOpen.direction,
            open_level: brokerOpen.open_level,
          },
        });
        if (rec.action === 'ADOPT') {
          clearPendingExecution(s.id);
          pushTick(s, {
            phase: 'INFO',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: rec.detail,
          });
        }
      } else if (s.open_side) {
        const pending = loadPendingExecution(s.id);
        // Do not clear in-flight entry while pending claim exists (listing lag)
        if (pending) {
          pushTick(s, {
            phase: 'WAIT',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: `Broker list flat but pending execution ${pending.deal_reference || 'claim'} — RECONCILING (not clearing)`,
          });
          s.close_phase = 'RECONCILING';
          persistBoFromSession(s);
        } else if (s.close_phase === 'CLOSE_UNCERTAIN' || s.close_phase === 'RECONCILING') {
          pushTick(s, {
            phase: 'EXIT',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: 'Broker flat after CLOSE_UNCERTAIN — confirmed CLOSED',
          });
          s.closed_at_ms = Date.now();
          const realizedGot = await fetchCapitalConfirmedProfit(
            opened.session,
            s.last_deal_reference
          );
          let wasLoss = false;
          if (
            realizedGot.ok &&
            realizedGot.profit != null &&
            Number.isFinite(realizedGot.profit)
          ) {
            wasLoss = realizedGot.profit <= 0;
            noteRiskTradePnl(s.account_id, realizedGot.profit);
            pushTick(s, {
              phase: 'INFO',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: `RISK PnL · broker realized ${realizedGot.profit} · ${realizedGot.detail}`,
            });
          } else {
            pushTick(s, {
              phase: 'INFO',
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              detail: `RISK PnL UNKNOWN · skipped noteRiskTradePnl · ${realizedGot.detail}`,
            });
          }
          noteEpicTradeClose(s.epic, s.open_side, wasLoss);
          clearTradeState(s);
        } else {
          pushTick(s, {
            phase: 'INFO',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: 'Broker flat on this epic — trade closed externally · FLAT (entry allowed)',
          });
          s.closed_at_ms = Date.now();
          noteEpicTradeClose(s.epic, s.open_side, false);
          clearTradeState(s);
        }
      } else {
        // Flat + pending claim without broker open
        const pending = loadPendingExecution(s.id);
        const rec = recoverPendingExecution({ pending, brokerOpen: null });
        if (rec.action === 'CLEAR_PENDING') {
          clearPendingExecution(s.id);
          pushTick(s, {
            phase: 'INFO',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: rec.detail,
          });
        } else if (rec.action === 'WAIT') {
          pushTick(s, {
            phase: 'WAIT',
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            detail: rec.detail,
          });
        }
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

    if (s.open_side && s.entry_price != null) {
      const excPx = manageExitPrice(s.open_side, quote);
      if (excPx != null) {
        updateExcursion(s, excPx, brokerOpen?.upl ?? s.unrealized);
      }
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
      // Keep Capital multi-TF seeded for ATR / structure_target during manage + restart
      if (!s.multiTf.ready || s.multiTf.seeded_at_ms == null) {
        try {
          if ((s.multiTf.seed_next_allowed_ms ?? 0) <= Date.now()) {
            s.multiTf = await seedMultiTfHistory(opened.session, s.epic, s.multiTf);
          }
        } catch {
          /* manage continues with whatever books exist */
        }
      } else {
        try {
          s.multiTf = await refreshDueTfBooks(opened.session, s.epic, s.multiTf);
        } catch {
          /* ignore refresh errors in manage */
        }
      }
      const liveSide = s.open_side || brokerOpen?.direction || null;
      const exitPx =
        liveSide === 'BUY' || liveSide === 'SELL'
          ? manageExitPrice(liveSide, quote)
          : quote.mid;
      if (exitPx == null) return;

      const short = shortNetMove(s.closedBars, s.ohlcState.forming ?? s.ohlcState.last_closed);
      if (liveSide === 'BUY' || liveSide === 'SELL') {
        const desk = deskOpensOnEpic(sessions.values(), s.epic, s.id);
        const hasOpposite =
          (liveSide === 'BUY' && desk.sells.length > 0) ||
          (liveSide === 'SELL' && desk.buys.length > 0);
        const conflict = deskConflictShouldExit(liveSide, hasOpposite, short.netPct);
        if (conflict.exit) {
          await exitTrade(opened.session, s, quote, conflict.reason);
          queueMicrotask(() => kickPeerManageCycles(s.id, s.epic));
          return;
        }
      }

      const signalForCont =
        s.ohlcState.forming && s.ohlcState.forming.ticks >= 2
          ? s.ohlcState.forming
          : s.ohlcState.last_closed;
      const tapeNow =
        liveSide === 'BUY' || liveSide === 'SELL'
          ? tapeSide(s.closedBars, signalForCont)
          : { dir: null as 'BUY' | 'SELL' | null, reason: '' };
      const oppositeEntrySignal = Boolean(
        liveSide && tapeNow.dir && tapeNow.dir !== liveSide
      );
      const cont =
        liveSide === 'BUY' || liveSide === 'SELL'
          ? continuationSameSide(liveSide, signalForCont, s.regime, s.closedBars)
          : { ok: false, reason: '' };

      // 5m BO — prefer Capital-native 5m ATR
      const fiveNative = s.multiTf.books['5m'].bars;
      const five =
        fiveNative.length >= 8 ? fiveNative : aggregateTenSecToFiveMin(s.closedBars);
      s.atr_5m = atrWilder(five, 14);

      // Structure / liquidity target distance (favorable pts) for continuation hold.
      // Prefer swing beyond the scalp zone — zone edge itself is not a trade target.
      if (s.structure_target == null && s.entry_price != null && five.length >= 8) {
        // Pass provenance as-is — analyzeMarketStructure keeps only explicit REAL
        const ms = analyzeMarketStructure(
          five.map((b) => ({
            open_time_ms: b.open_time_ms,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            ticks: b.ticks,
            provenance: b.provenance,
          })),
          { pivotLeft: 1, pivotRight: 1 }
        );
        const zone = buildScalpZone(s.closedBars);
        if (s.open_side === 'BUY') {
          let lvl = ms.last_swing_high?.price ?? null;
          if (lvl != null && zone?.high != null && lvl <= zone.high + 1e-9) {
            const highs = ms.pivots.filter((p) => p.kind === 'HIGH' && p.price > zone.high!);
            lvl = highs[highs.length - 1]?.price ?? null;
          }
          if (lvl != null && lvl > s.entry_price) s.structure_target = lvl - s.entry_price;
        } else if (s.open_side === 'SELL') {
          let lvl = ms.last_swing_low?.price ?? null;
          if (lvl != null && zone?.low != null && lvl >= zone.low - 1e-9) {
            const lows = ms.pivots.filter((p) => p.kind === 'LOW' && p.price < zone.low!);
            lvl = lows[lows.length - 1]?.price ?? null;
          }
          if (lvl != null && lvl < s.entry_price) s.structure_target = s.entry_price - lvl;
        }
        if (s.structure_target != null) persistBoFromSession(s);
      }

      const bars5mForBo = fiveNative.map((b) => ({
        open_time_ms: b.open_time_ms,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        ticks: b.ticks,
        provenance: b.provenance,
      }));
      const bars1mForBo = s.multiTf.books['1m'].bars.map((b) => ({
        open_time_ms: b.open_time_ms,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        ticks: b.ticks,
        provenance: b.provenance,
        forming: b.forming,
      }));
      const bars10sForBo = s.closedBars.map((b) => ({
        open_time_ms: b.open_time_ms,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        ticks: b.ticks,
        provenance: b.provenance,
      }));

      const decision = decideBestOutcomeExit(
        {
          ...s,
          short_net_pct: short.netPct,
          atr: s.atr_5m,
          structural_sl: s.structural_sl,
          structure_target: s.structure_target,
          tick_size: quote.point_size ?? null,
        },
        exitPx,
        {
          oppositeEntrySignal,
          oppositeReason: tapeNow.reason,
          continuationSameSide: cont.ok && !oppositeEntrySignal,
          ignoreMicroOpposite: Boolean(cont.ok && s.mfe >= (s.atr_5m ?? 0) * 0.25),
          bars5m: bars5mForBo,
          bars1m: bars1mForBo,
          bars10s: bars10sForBo,
        }
      );
      if (decision.exit) {
        await exitTrade(opened.session, s, quote, decision.reason);
        queueMicrotask(() => kickPeerManageCycles(s.id, s.epic));
        return;
      }

      const zone = buildScalpZone(s.closedBars);
      pushTick(s, {
        phase: 'MANAGE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `${formatScanContext(s, zone)} · UPL ${
          s.unrealized != null ? s.unrealized.toFixed(5) : '—'
        } · MFE ${s.mfe.toFixed(5)} · ret ${
          s.peak_retention != null ? `${(s.peak_retention * 100).toFixed(0)}%` : '—'
        } · ${
          describeBestOutcomeState(
            {
              ...s,
              short_net_pct: short.netPct,
              atr: s.atr_5m,
              structural_sl: s.structural_sl,
              structure_target: s.structure_target,
              tick_size: quote.point_size ?? null,
            },
            exitPx,
            {
              oppositeEntrySignal,
              oppositeReason: tapeNow.reason,
              continuationSameSide: cont.ok && !oppositeEntrySignal,
              continuationReason: cont.ok ? cont.reason : tapeNow.reason || 'waiting opposite',
              bars5m: bars5mForBo,
              bars1m: bars1mForBo,
              bars10s: bars10sForBo,
            }
          ).hold
        }`,
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

    // Analysis domain = MID (#66). Bid/ask reserved for execution / realizable PnL.
    const analysisPrice = analysisMid(quote);
    if (analysisPrice == null) {
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: 'ENTRY BLOCKED · analysis MID UNKNOWN · no trade',
      });
      return;
    }

    // Seed / refresh Capital-native multi-TF history (primary) before any ENTRY READY
    const needSeed =
      !s.multiTf.ready ||
      Date.now() - s.last_multi_tf_seed_ms >= 60_000 ||
      s.multiTf.seeded_at_ms == null;
    if (needSeed) {
      s.last_multi_tf_seed_ms = Date.now();
      try {
        s.multiTf = await seedMultiTfHistory(opened.session, s.epic, s.multiTf);
        pushTick(s, {
          phase: 'INFO',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `TF seed · ${s.multiTf.detail}`,
        });
      } catch (err) {
        s.multiTf = {
          ...s.multiTf,
          ready: false,
          detail: `TF seed fail · ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      s.multiTf = await refreshDueTfBooks(opened.session, s.epic, s.multiTf);
      s.last_multi_tf_seed_ms = Date.now();
    }

    if (!s.multiTf.ready) {
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `ENTRY BLOCKED · multi-TF history not ready · ${s.multiTf.detail}`,
      });
      return;
    }

    // Structure books must be present (closed bars only — forming never confirms)
    const structReady =
      s.multiTf.books['4H'].ready &&
      s.multiTf.books['1H'].ready &&
      s.multiTf.books['15m'].ready &&
      s.multiTf.books['5m'].ready &&
      s.multiTf.books['1m'].ready &&
      s.multiTf.books['5m'].bars.length >= 8 &&
      s.multiTf.books['5m'].atr != null;
    if (!structReady) {
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: 'ENTRY BLOCKED · structure/data-quality NOT_READY · no trade',
      });
      return;
    }

    // Keep armed SETUP→ARMED machine fresh for UI + early entry between 10s buckets
    s.armed_trigger = refreshArmedTriggerState(s.armed_trigger, {
      price: analysisPrice,
      multiTf: s.multiTf,
      closedBars: s.closedBars,
      spread: quote.spread ?? null,
      tick_size: quote.point_size ?? null,
      broker_min_stop: quote.min_stop_distance ?? null,
    });

    // 10s for microstructure / trigger only (not HTF)
    if (Date.now() - s.last_second_fetch_ms >= 4_000) {
      s.last_second_fetch_ms = Date.now();
      const sec = await fetchCapitalPrices(opened.session, s.epic, 'SECOND', 100);
      if (sec.ok && sec.candles.length >= 20) {
        const bars = aggregateSecondsToTen(sec.candles);
        const last = bars[bars.length - 1];
        if (last) {
          const bucket = String(last.open_time_ms || 0);
          const isNew = Boolean(bucket) && bucket !== s.last_closed_bar_key;
          s.ohlcState = {
            forming: s.ohlcState.forming,
            last_closed: last,
            just_closed: isNew,
          };
          if (isNew) s.last_closed_bar_key = bucket;
          s.ohlc_10s = publicOhlc10s(s.ohlcState);
          applyRobotRegime(s, bars);
          for (const b of bars) {
            const prev = s.closedBars[s.closedBars.length - 1];
            if (prev && prev.open_time_ms === b.open_time_ms) s.closedBars[s.closedBars.length - 1] = b;
            else s.closedBars.push(b);
          }
          if (s.closedBars.length > MAX_REGIME_BARS) {
            s.closedBars = s.closedBars.slice(-MAX_REGIME_BARS);
          }
        }
      }
    }

    const zoneNow = buildScalpZone(s.closedBars);
    const feedGate = allowEntryFromFeeds(s.multiFeed);
    if (!feedGate.ok) {
      pushTick(s, {
        phase: 'DECIDE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `NO ENTRY · feeds · ${feedGate.reason} · ${formatArmedTriggerDiag(s.armed_trigger, analysisPrice)} · ${formatScanContext(s, zoneNow, feedGate.reason)}`,
      });
      return;
    }

    const quoteFetchMs = s.last_quote_fetch_ms || Date.now();
    const sourceMs = quote.update_time ? Date.parse(quote.update_time) : null;
    const dq = allowEntryFromDataQuality(
      {
        mid: analysisPrice,
        fetch_ms: quoteFetchMs,
        source_ms: sourceMs != null && Number.isFinite(sourceMs) ? sourceMs : null,
      },
      { nowMs: Date.now(), maxStaleMs: 15_000 }
    );
    if (!dq.ok) {
      pushTick(s, {
        phase: 'DECIDE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `NO ENTRY · data quality · ${dq.reason} · ${formatArmedTriggerDiag(s.armed_trigger, analysisPrice)}`,
      });
      return;
    }

    // riskWindow is monitor/PnL stats only — NEVER an entry blocker (manual lot_size is authoritative;
    // entry does not depend on Capital balance/equity).
    const risk = allowRiskEntry(s.account_id, s.unrealized ?? 0);
    persistRiskSnapshotJson(s.account_id, risk.snapshot);

    const closed = s.ohlcState.last_closed;
    const forming = s.ohlcState.forming;
    const justClosed = Boolean(s.ohlcState.just_closed && closed);
    const signalBar: TenSecBar | null = justClosed
      ? closed!
      : forming && forming.ticks >= 2
        ? forming
        : closed || null;
    const liveSignal = Boolean(signalBar && !justClosed);
    const ohlc = s.ohlc_10s;
    const show = signalBar || closed;
    const ohlcLine = show
      ? `10s${liveSignal ? ' LIVE' : justClosed ? ' CLOSE' : ''} O=${show.open.toFixed(2)} H=${show.high.toFixed(2)} L=${show.low.toFixed(2)} C=${show.close.toFixed(2)}${show.provenance === 'SYNTHETIC' ? ' SYN' : ''}`
      : `10s OHLC seeding · C=${ohlc.forming_c != null ? ohlc.forming_c.toFixed(2) : '—'}`;

    let direction: 'BUY' | 'SELL' | null = null;
    let reason = '';
    let setupType: string | null = null;

    if (!signalBar) {
      pushTick(s, {
        phase: 'DECIDE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `NO ENTRY · no LTF signal bar · ${formatArmedTriggerDiag(s.armed_trigger, analysisPrice)} · ${ohlcLine} · ${formatScanContext(s, zoneNow)}`,
      });
      return;
    }

    if (signalBar.provenance === 'SYNTHETIC') {
      pushTick(s, {
        phase: 'DECIDE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `NO ENTRY · synthetic 10s barred · ${formatArmedTriggerDiag(s.armed_trigger, analysisPrice)} · ${formatScanContext(s, zoneNow)}`,
      });
      return;
    }

    if (!s.regime) s.regime = 'RANGE';
    const bucketKey = String(signalBar.open_time_ms || 0);
    if (bucketKey && bucketKey === s.last_entry_signal_key && !liveSignal) {
      pushTick(s, {
        phase: 'DECIDE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `NO ENTRY · same 10s bucket already scanned · ${formatArmedTriggerDiag(s.armed_trigger, analysisPrice)} · ${ohlcLine}`,
      });
      return;
    }

    const execQ = tagExecutionQuote({
      bid: quote.bid,
      ask: quote.ask,
      mid: analysisPrice,
    });
    const confLegs = (s.feed_legs || [])
      .filter((l) => l.mid != null)
      .map((l) => tagConfirmationQuote(l.name || l.sender_id || 'feed', Number(l.mid)));
    const refAgree = referenceAgreement(execQ.mid, confLegs);

    const htf = buildHtfContextFromBooks(s.multiTf, analysisPrice);
    const bars5m = s.multiTf.books['5m'].bars;
    const bars1m = s.multiTf.books['1m'].bars;
    const bars15m = s.multiTf.books['15m'].bars;

    const sig = decideEntryFrom10sRegime(signalBar, s.regime, s.closedBars, {
      spread: quote.spread ?? execQ.spread,
      feed_agreement: refAgree.agreement,
      broker_min_stop: quote.min_stop_distance,
      htf,
      bars5m,
      bars1m,
      bars15m,
      multiTfReady: s.multiTf.ready,
      analysis_price: analysisPrice,
      tick_size: quote.point_size ?? null,
      armed_state: s.armed_trigger,
      on_armed_state: (st) => {
        s.armed_trigger = st;
      },
    });
    if (!sig) {
      pushTick(s, {
        phase: 'DECIDE',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `NO ENTRY · decide null · ${formatArmedTriggerDiag(s.armed_trigger, analysisPrice)} · ${ohlcLine} · ${explainNoEntry(signalBar, s.regime, s.closedBars, {
          multiTfReady: s.multiTf.ready,
          analysis_price: analysisPrice,
          armed_state: s.armed_trigger,
          htf,
          bars5m,
          bars1m,
        })} · HTF ${htf.detail}`,
      });
      return;
    }

    // EARLY TRIGGERED → execute. No post-trigger stale/reentry veto (5m move won't wait).
    const isEarlyTrigger = /EARLY|TRIGGERED/i.test(sig.reason);
    if (!isEarlyTrigger) {
      const reentry = allowEpicReentry(s.epic, sig.direction);
      if (!reentry.ok) {
        pushTick(s, {
          phase: 'WAIT',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `NO ENTRY · ${reentry.reason} · ${formatArmedTriggerDiag(s.armed_trigger, analysisPrice)}`,
        });
        return;
      }
      const staleDir = detectStaleQuoteAdverse(
        sig.direction,
        analysisPrice,
        confLegs.map((c) => ({ label: c.label, mid: c.mid })),
        { requireRefs: false }
      );
      if (staleDir.block) {
        pushTick(s, {
          phase: 'DECIDE',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `NO ENTRY · stale guard · ${staleDir.reason} · ${formatArmedTriggerDiag(s.armed_trigger, analysisPrice)}`,
        });
        return;
      }
    }

    direction = sig.direction;
    setupType = sig.setup;
    if (sig.structural_sl != null) s.structural_sl = sig.structural_sl;
    reason = liveSignal ? `LIVE LTF confirm · ${sig.reason}` : sig.reason;
    if (bucketKey) s.last_entry_signal_key = bucketKey;

    pushTick(s, {
      phase: 'ORDER',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `ENTRY READY · ${reason} · ${htf.detail}`,
    });

    await enterTrade(
      opened.session,
      s,
      direction,
      quote,
      reason,
      setupType,
      sig.structural_sl
    );
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
    structural_sl: null,
    structure_target: null,
    atr_5m: null,
    risk_open_noted: false,
    close_phase: 'CLOSED',
    error: null,
    entry_enabled: input.entry_enabled !== false,
    timer: null,
    closed_at_ms: 0,
    peak_favorable: 0,
    last_market_closed_tick_ms: 0,
    last_market_tradeable: true,
    market_status: null,
    market_tradeable: true,
    cadence_ms: 0,
    ohlcState: emptyTenSecState(),
    last_second_fetch_ms: 0,
    last_closed_bar_key: '',
    last_entry_signal_key: '',
    closedBars: [],
    last_multi_feed_ms: 0,
    multiFeed: null,
    cycle_busy: false,
    journal_open: null,
    pending_deal_reference: null,
    multiTf: emptyMultiTfState(),
    last_multi_tf_seed_ms: 0,
    last_quote_fetch_ms: 0,
    armed_trigger: idleArmedState(),
    feed_source: 'NONE',
    feed_contributing: 0,
    feed_sender_count: 0,
    feed_agreement: null,
    regime: 'UNKNOWN',
    ohlc_10s: publicOhlc10s(emptyTenSecState()),
  };

  const others = [...sessions.values()].filter((x) => x.running && x.id !== id).length;
  pushTick(session, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: null,
    detail: `ROBOT START · id=${id} · ${displayName} (${epic}) · lot ${lot} · ${acc.environment.toUpperCase()} · multi-TF Capital history · ONE TRADE · other robots: ${others}`,
  });
  pushTick(session, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: null,
    detail:
      '4H/1H→15m→5m→1m→10s brain · ENTRY blocked until TF seed ready · structural SL + Safety SL · BO · journal → ' +
      tradeJournalPath(),
  });

  // Restart recovery — Capital open = truth
  const priorBo = loadBoState(id);
  if (priorBo) {
    session.open_side = priorBo.side;
    session.deal_id = priorBo.deal_id;
    session.entry_price = priorBo.entry_price;
    session.entry_at = priorBo.entry_at;
    session.mfe = priorBo.mfe;
    session.mae = priorBo.mae;
    session.peak_favorable = priorBo.peak_favorable;
    session.peak_retention = priorBo.peak_retention;
    session.structural_sl = priorBo.structural_sl;
    session.safety_sl = priorBo.safety_sl;
    session.structure_target = priorBo.structure_target ?? null;
    session.mode = 'MANAGE';
    session.close_phase = priorBo.close_phase === 'CLOSED' ? 'OPEN' : priorBo.close_phase;
    pushTick(session, {
      phase: 'INFO',
      bid: null,
      ask: null,
      mid: null,
      detail: `BO recover · prior state deal=${priorBo.deal_id} MFE=${priorBo.mfe}${
        priorBo.structure_target != null ? ` structTgt=${priorBo.structure_target}` : ''
      } · will sync Capital`,
    });
  }

  sessions.set(id, session);
  try {
    await markRobotDesiredRunning({
      id,
      account_id: acc.id,
      epic,
      display_name: displayName,
      lot_size: lot,
      trading_enabled: session.trading_enabled,
      entry_enabled: session.entry_enabled,
    });
  } catch (err) {
    console.warn('[robot-desk] persist start failed', err);
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
  safety_sl?: number | null;
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
    if (input.safety_sl != null) existing.safety_sl = input.safety_sl;
    existing.orders_placed = Math.max(existing.orders_placed, 1);
    if (!existing.journal_open) {
      existing.journal_open = buildJournalOpen(
        existing,
        input.side,
        `PIPELINE FILL · ${input.setup_type || input.regime || 'intent'}`,
        input.setup_type ?? null,
        'pipeline'
      );
      appendOpenEvent(existing.journal_open);
    }
    pushTick(existing, {
      phase: 'ORDER',
      bid: null,
      ask: null,
      mid: input.entry_price,
      detail: `PIPELINE FILL ${input.side} ${input.display_name} lot=${input.lot_size} · ${
        existing.regime
      } · manage-only (kept MFE ${existing.mfe.toFixed(5)}) · journal ${existing.journal_open.trade_id}`,
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
    if (input.safety_sl != null) internal.safety_sl = input.safety_sl;
    internal.journal_open = buildJournalOpen(
      internal,
      input.side,
      `PIPELINE FILL · ${input.setup_type || input.regime || 'intent'}`,
      input.setup_type ?? null,
      'pipeline'
    );
    appendOpenEvent(internal.journal_open);
    pushTick(internal, {
      phase: 'ORDER',
      bid: null,
      ask: null,
      mid: input.entry_price,
      detail: `PIPELINE FILL ${input.side} ${input.display_name} lot=${input.lot_size} · ${
        internal.regime
      } · manage-only attached · journal ${internal.journal_open.trade_id}`,
    });
  }
  return getRobotSession(session.id) || session;
}

/** After API/PC restart — bring back robots that were running (Postgres persist). */
export async function restorePersistedRobotSessions(): Promise<{
  restored: number;
  failed: number;
}> {
  const desired = await listDesiredRunningRobots();
  let restored = 0;
  let failed = 0;
  for (const row of desired) {
    try {
      const id = robotIdFor(row.account_id, row.epic);
      const existing = sessions.get(id);
      if (existing?.running) {
        restored += 1;
        continue;
      }
      await startRobotSession({
        account_id: row.account_id,
        epic: row.epic,
        display_name: row.display_name || undefined,
        lot_size: row.lot_size,
        trading_enabled: row.trading_enabled,
        entry_enabled: row.entry_enabled,
      });
      restored += 1;
      console.log(
        `[robot-desk] restored ${row.display_name || row.epic} · account #${row.account_id}`
      );
    } catch (err) {
      failed += 1;
      console.warn(
        `[robot-desk] restore failed account=${row.account_id} epic=${row.epic}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return { restored, failed };
}
