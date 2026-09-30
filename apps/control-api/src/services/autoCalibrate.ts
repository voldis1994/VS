/**
 * Ultimate desk auto-calibrate — watches closes since robot START and
 * retunes Soft/HardInv (abs+pct), Peak/Target, genome Peak/Soft memory,
 * multi-TF/regime perception, and regime allowlist every N closes.
 *
 * Freedom policy: Soft/HardInv/genome/regimes/entry filters may all move for
 * better expectancy. Start OPEN TRADE-ALL; self-correct from closes + market ctx.
 * Never empty allowlist below MIN_ENABLED_REGIMES. Lot untouched.
 * WHAT/WHY change logs for GUI + LIVE LOG.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultDeskCalibration,
  getDeskCalibration,
  setDeskCalibration,
  tradableDefaultRegimes,
  type DeskCalibration,
} from './deskCalibration.js';
import { summarizeExitReason } from './tradeLedger.js';
import type { RegimeName } from './regimes.js';
import { resolveDeskClientId } from './deskClientScope.js';
import type { MarketContextCompact } from './marketContext.js';
import { reviewSessionLikeHuman } from './traderMind.js';
import {
  getBrainGenome,
  setBrainGenome,
  type BrainGenome,
} from '../brainSelfImprove/brainGenome.js';
import {
  readSoftTargetLayers,
  suggestLayersFromExcursions,
} from './profitLayers.js';

export const AUTO_CALIBRATE_EVERY_N = 5;
/** After an applied calibrate — space next cycle; entries stay open. */
export const AUTO_CALIBRATE_COOLDOWN_MS = 3 * 60_000;
/** Never drop below this many regimes — entries stay possible. */
export const MIN_ENABLED_REGIMES = 5;
/** Wide caps — learner explores; desk sanitize is the hard wall. */
export const AUTO_CAL_MAX_SAFETY_TP_RR = 3.0;
export const AUTO_CAL_MAX_TARGET_ABS = 12.0;
export const AUTO_CAL_MAX_PEAK_MFE_ABS = 8.0;
export const AUTO_CAL_MAX_PEAK_RETENTION = 0.95;
/** Peak Keep % — full freedom (10%…95%). Old floors 65/78% blocked real regulation. */
export const AUTO_CAL_MIN_PEAK_RETENTION = 0.1;
/** Soft HardInv CAP range — full Soft freedom. */
export const AUTO_CAL_MIN_HARDINV_ABS = 0.5;
export const AUTO_CAL_MAX_HARDINV_ABS = 8.0;
export const AUTO_CAL_MIN_HARDINV_PCT = 0.0002;
export const AUTO_CAL_MAX_HARDINV_PCT = 0.004;
export const AUTO_CAL_MIN_TARGET_PCT = 0.0008;
export const AUTO_CAL_MAX_TARGET_PCT = 0.01;
export const AUTO_CAL_MIN_PEAK_MFE_PCT = 0.0002;
export const AUTO_CAL_MAX_PEAK_MFE_PCT = 0.006;
/** After this many consecutive "raise winners" cycles with still-bad E → pull back. */
export const AUTO_CAL_RAISE_STREAK_BEFORE_PULLBACK = 2;

/**
 * Preferred liquid regimes at factory open. May demote when consistently losing;
 * floor refill from tradable defaults keeps the robot from starving.
 */
export const CORE_ALWAYS_ON_REGIMES: readonly string[] = [
  'RANGE',
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
  'EXPANSION',
  'COMPRESSION',
  'TRANSITION',
] as const;

export function isCoreAlwaysOnRegime(regime: string): boolean {
  return CORE_ALWAYS_ON_REGIMES.includes(String(regime || '').toUpperCase());
}

/** Structured WHAT/WHY log for GUI + LIVE LOG. */
export function autotuneLog(what: string, why: string): string {
  return `WHAT · ${what} · WHY · ${why}`;
}

/** Clean abs pts (1 decimal) — avoid 1.4→1.3999998 no-ops / UI noise. */
function roundAbs(n: number): number {
  return Math.round(n * 10) / 10;
}
/** Clean retention / keep (2 decimals). */
function roundRet(n: number): number {
  return Math.round(n * 100) / 100;
}
/** Clean RR (2 decimals). */
function roundRr(n: number): number {
  return Math.round(n * 100) / 100;
}
/** Clean pct knobs (5 decimals) — genome trek / target_pct dust. */
function roundPct(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/**
 * Soft pct is derived from Soft abs — never independent *1.05 micro-junk (0.00080→0.00084).
 * Ref mid 2750 matches factory Soft 2.2 / 0.0008. Steps of 0.0001 only.
 */
export const SOFT_PCT_REF_MID = 2750;
export function softPctFromAbs(hardinvAbs: number): number {
  const raw = Math.max(0, Number(hardinvAbs) || 0) / SOFT_PCT_REF_MID;
  return Math.round(raw * 1e4) / 1e4;
}

/** True when a calibration knob or regime allowlist actually differs (ignores updated_at). */
function deskCalibrationMateriallyChanged(a: DeskCalibration, b: DeskCalibration): boolean {
  if (a.hardinv_abs !== b.hardinv_abs) return true;
  if (a.soft_l1_abs !== b.soft_l1_abs) return true;
  if (a.soft_l2_abs !== b.soft_l2_abs) return true;
  if (a.soft_l3_abs !== b.soft_l3_abs) return true;
  if (a.peak_mfe_abs !== b.peak_mfe_abs) return true;
  if (a.peak_retention !== b.peak_retention) return true;
  if (a.peak_min_giveback_abs !== b.peak_min_giveback_abs) return true;
  if (a.target_abs !== b.target_abs) return true;
  if (a.target_l1_abs !== b.target_l1_abs) return true;
  if (a.target_l2_abs !== b.target_l2_abs) return true;
  if (a.target_l3_abs !== b.target_l3_abs) return true;
  if (a.safety_tp_rr !== b.safety_tp_rr) return true;
  if (a.hardinv_pct !== b.hardinv_pct) return true;
  if (a.target_pct !== b.target_pct) return true;
  if (a.peak_mfe_pct !== b.peak_mfe_pct) return true;
  if (a.entry_filter_level !== b.entry_filter_level) return true;
  const ra = [...a.enabled_regimes].map((r) => String(r).toUpperCase()).sort();
  const rb = [...b.enabled_regimes].map((r) => String(r).toUpperCase()).sort();
  if (ra.length !== rb.length) return true;
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return true;
  }
  return false;
}

export type SessionTrade = {
  pnl_pts: number;
  regime: string | null;
  setup_type: string | null;
  exit_reason: string | null;
  mfe: number;
  mae: number;
  at: string;
  robot_id?: string | null;
  epic?: string | null;
  /** Market context at entry (frozen) */
  entry_ctx?: MarketContextCompact | null;
  /** Market context at exit */
  exit_ctx?: MarketContextCompact | null;
};

export type AutoCalCycleRecord = {
  at: string;
  summary: string;
  changes: string[];
  applied: boolean;
  window_expectancy: number;
  window_sum_pts: number;
  closes_at_cycle: number;
  cooldown_sec: number;
};

export type AutoCalibrateStatus = {
  client_id: number;
  enabled: boolean;
  session_started_at: string | null;
  closes_in_session: number;
  closes_until_next: number;
  cycles_run: number;
  last_cycle_at: string | null;
  last_summary: string | null;
  last_changes: string[];
  /** True while post-change settle spaces the next auto-cal cycle (entries stay open) */
  cooling_down: boolean;
  cooldown_until: string | null;
  cooldown_left_s: number;
  session_sum_pts: number;
  session_expectancy_pts: number;
  session_wins: number;
  session_losses: number;
  last_window_expectancy: number | null;
  history: AutoCalCycleRecord[];
  knobs_now: {
    hardinv_abs: number;
    hardinv_pct: number;
    peak_mfe_abs: number;
    peak_retention: number;
    target_abs: number;
    target_pct: number;
    safety_tp_rr: number;
    entry_filter_level: number;
    enabled_regimes: number;
    genome_peak_keep: number;
    genome_soft_giveback: number;
    genome_pullback_episode_arm: number;
  };
};

export type AutoCalibrateProposeResult = {
  applied: boolean;
  summary: string;
  changes: string[];
  next: DeskCalibration;
  genome_patch?: Partial<BrainGenome>;
  genome_changes?: string[];
};

type SessionState = {
  started_at: string | null;
  trades: SessionTrade[];
  cycles_run: number;
  last_cycle_at: string | null;
  last_summary: string | null;
  last_changes: string[];
  /** Soft-demoted this session — can be re-promoted on positive cycles */
  demoted: Set<string>;
  cooldown_until_ms: number | null;
  last_window_expectancy: number | null;
  history: AutoCalCycleRecord[];
  /** Consecutive cycles that raised Peak/Target/TP RR */
  raise_streak: number;
};

type ClientBucket = {
  enabled: boolean;
  hydrated: boolean;
  state: SessionState;
};

const buckets = new Map<number, ClientBucket>();

function emptyState(): SessionState {
  return {
    started_at: null,
    trades: [],
    cycles_run: 0,
    last_cycle_at: null,
    last_summary: null,
    last_changes: [],
    demoted: new Set(),
    cooldown_until_ms: null,
    last_window_expectancy: null,
    history: [],
    raise_streak: 0,
  };
}

function sessionPath(clientId: number): string {
  const env = process.env.AUTO_CALIBRATE_SESSION_PATH?.trim();
  if (env && clientId <= 0) return env;
  if (clientId > 0) {
    return path.join(process.cwd(), 'data', 'auto-calibrate', `client-${clientId}.json`);
  }
  return path.join(process.cwd(), 'data', 'auto-calibrate-session.json');
}

function bucket(clientId?: number | null): ClientBucket {
  const id = resolveDeskClientId(clientId);
  let b = buckets.get(id);
  if (!b) {
    b = { enabled: true, hydrated: false, state: emptyState() };
    buckets.set(id, b);
  }
  return b;
}

function persistSession(clientId?: number | null): void {
  const id = resolveDeskClientId(clientId);
  const b = bucket(id);
  try {
    const file = sessionPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const st = b.state;
    const payload = {
      client_id: id,
      enabled: b.enabled,
      started_at: st.started_at,
      trades: st.trades.slice(-80),
      cycles_run: st.cycles_run,
      last_cycle_at: st.last_cycle_at,
      last_summary: st.last_summary,
      last_changes: st.last_changes,
      demoted: [...st.demoted],
      cooldown_until_ms: st.cooldown_until_ms,
      last_window_expectancy: st.last_window_expectancy,
      history: st.history.slice(0, 12),
      raise_streak: st.raise_streak,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    /* best effort */
  }
}

function hydrateSession(clientId?: number | null): void {
  const id = resolveDeskClientId(clientId);
  const b = bucket(id);
  if (b.hydrated) return;
  b.hydrated = true;
  try {
    const file = sessionPath(id);
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (typeof raw.enabled === 'boolean') b.enabled = raw.enabled;
    const st = b.state;
    st.started_at = typeof raw.started_at === 'string' ? raw.started_at : null;
    st.trades = Array.isArray(raw.trades) ? (raw.trades as SessionTrade[]) : [];
    st.cycles_run = Number(raw.cycles_run) || 0;
    st.last_cycle_at = typeof raw.last_cycle_at === 'string' ? raw.last_cycle_at : null;
    st.last_summary = typeof raw.last_summary === 'string' ? raw.last_summary : null;
    st.last_changes = Array.isArray(raw.last_changes) ? (raw.last_changes as string[]) : [];
    st.demoted = new Set(
      Array.isArray(raw.demoted) ? (raw.demoted as string[]).map((x) => String(x)) : []
    );
    st.cooldown_until_ms =
      raw.cooldown_until_ms != null && Number.isFinite(Number(raw.cooldown_until_ms))
        ? Number(raw.cooldown_until_ms)
        : null;
    st.last_window_expectancy =
      raw.last_window_expectancy != null && Number.isFinite(Number(raw.last_window_expectancy))
        ? Number(raw.last_window_expectancy)
        : null;
    st.history = Array.isArray(raw.history) ? (raw.history as AutoCalCycleRecord[]) : [];
    st.raise_streak = Number(raw.raise_streak) || 0;
  } catch {
    /* ignore corrupt disk */
  }
}

/** Factory open — ensure ALL tradable regimes ON (trade everything). */
function ensureTradeAllRegimesOn(clientId?: number | null): void {
  const id = resolveDeskClientId(clientId);
  try {
    const cur = getDeskCalibration(id);
    const want = tradableDefaultRegimes();
    const have = new Set(cur.enabled_regimes.map((r) => String(r).toUpperCase()));
    let changed = false;
    for (const r of want) {
      if (!have.has(r)) {
        have.add(r);
        changed = true;
      }
    }
    if (changed) {
      setDeskCalibration(
        { enabled_regimes: [...have] as never, soft_off_regimes: [] },
        id
      );
    }
  } catch {
    /* ignore */
  }
}

/** @deprecated alias — trade-all open uses full tradable set */
function ensureCoreRegimesOn(clientId?: number | null): void {
  ensureTradeAllRegimesOn(clientId);
}

/** Snap already-overreached knobs back to caps (live sessions that climbed too far). */
function clampOverreachKnobs(clientId?: number | null): void {
  const id = resolveDeskClientId(clientId);
  try {
    const cur = getDeskCalibration(id);
    const patch: Partial<typeof cur> = {};
    if (cur.safety_tp_rr > AUTO_CAL_MAX_SAFETY_TP_RR) patch.safety_tp_rr = AUTO_CAL_MAX_SAFETY_TP_RR;
    if (cur.target_abs > AUTO_CAL_MAX_TARGET_ABS) patch.target_abs = AUTO_CAL_MAX_TARGET_ABS;
    if (cur.peak_mfe_abs > AUTO_CAL_MAX_PEAK_MFE_ABS) patch.peak_mfe_abs = AUTO_CAL_MAX_PEAK_MFE_ABS;
    if (cur.peak_retention > AUTO_CAL_MAX_PEAK_RETENTION) {
      patch.peak_retention = AUTO_CAL_MAX_PEAK_RETENTION;
    }
    // entry_filter_level 0–3 is free — do not snap L3 back to OPEN
    if (Object.keys(patch).length) setDeskCalibration(patch, id);
  } catch {
    /* ignore */
  }
}
void clampOverreachKnobs;

export function setAutoCalibrateEnabled(on: boolean, clientId?: number | null): void {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const b = bucket(id);
  b.enabled = Boolean(on);
  persistSession(id);
}

export function isAutoCalibrateEnabled(clientId?: number | null): boolean {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  return bucket(id).enabled;
}

/**
 * Factory open: Soft/Peak/Target/TP RR defaults, filters L0, ALL regimes ON,
 * wipe auto-cal watch. Use on Reset — start trading everything again.
 */
export function resetClientToOpenTradeAll(
  clientId?: number | null,
  reason = 'factory_open'
): AutoCalibrateStatus {
  const id = resolveDeskClientId(clientId);
  try {
    setDeskCalibration({ ...defaultDeskCalibration() }, id);
  } catch {
    /* ignore */
  }
  return beginAutoCalibrateSession(reason, id);
}

/** Clear watch window; always restores OPEN trade-all calibration. */
export function beginAutoCalibrateSession(
  reason = 'robot_start',
  clientId?: number | null
): AutoCalibrateStatus {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const st = bucket(id).state;
  st.started_at = new Date().toISOString();
  st.trades = [];
  st.cycles_run = 0;
  st.last_cycle_at = null;
  st.last_summary = `OPEN TRADE-ALL · client ${id} · ${reason} · Soft+HardInv+genome free · all regimes`;
  st.last_changes = [
    autotuneLog(
      'factory open Soft 2.2/pct0.0008 · Peak 3 keep72% · Target 5 · TP RR 1.5 · filters 0 · all regimes',
      'Sākt no jauna — trade everything, self-correct from closes'
    ),
  ];
  st.demoted.clear();
  st.cooldown_until_ms = null;
  st.last_window_expectancy = null;
  st.history = [];
  st.raise_streak = 0;
  try {
    setDeskCalibration({ ...defaultDeskCalibration() }, id);
  } catch {
    /* ignore */
  }
  ensureTradeAllRegimesOn(id);
  persistSession(id);
  return getAutoCalibrateStatus(undefined, id);
}

/**
 * Robot START — keep the close watch (do NOT wipe counted trades).
 * Factory wipe only via SĀKT NO JAUNA / resetClientToOpenTradeAll.
 */
export function ensureAutoCalibrateSession(
  reason = 'robot_start',
  clientId?: number | null
): AutoCalibrateStatus {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const st = bucket(id).state;
  if (!st.started_at) {
    st.started_at = new Date().toISOString();
    st.last_summary = `session · client ${id} · ${reason} · OPEN`;
    st.last_changes = [
      autotuneLog(`session start · ${reason}`, 'closes preserved · Soft/genome free to learn'),
    ];
    ensureTradeAllRegimesOn(id);
    persistSession(id);
  }
  return getAutoCalibrateStatus(undefined, id);
}

export function isAutoCalibrateCooldownActive(
  nowMs = Date.now(),
  clientId?: number | null
): boolean {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const until = bucket(id).state.cooldown_until_ms;
  return until != null && Number.isFinite(until) && nowMs < until;
}

export function autoCalibrateCooldownLeftSec(
  nowMs = Date.now(),
  clientId?: number | null
): number {
  const id = resolveDeskClientId(clientId);
  if (!isAutoCalibrateCooldownActive(nowMs, id)) return 0;
  const until = bucket(id).state.cooldown_until_ms;
  if (until == null) return 0;
  return Math.max(0, Math.ceil((until - nowMs) / 1000));
}

function sessionStats(clientId: number) {
  const pts = bucket(clientId).state.trades.map((t) => t.pnl_pts);
  const sum = pts.reduce((a, b) => a + b, 0);
  const wins = pts.filter((p) => p > 1e-9).length;
  const losses = pts.filter((p) => p < -1e-9).length;
  return {
    session_sum_pts: sum,
    session_expectancy_pts: pts.length ? sum / pts.length : 0,
    session_wins: wins,
    session_losses: losses,
  };
}

export function getAutoCalibrateStatus(
  nowMs?: number,
  clientId?: number | null
): AutoCalibrateStatus {
  const now = nowMs ?? Date.now();
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const st = bucket(id).state;
  const n = st.trades.length;
  const mod = n % AUTO_CALIBRATE_EVERY_N;
  const until =
    n === 0 ? AUTO_CALIBRATE_EVERY_N : mod === 0 && n > 0 ? AUTO_CALIBRATE_EVERY_N : AUTO_CALIBRATE_EVERY_N - mod;
  const cooling = isAutoCalibrateCooldownActive(now, id);
  const left = autoCalibrateCooldownLeftSec(now, id);
  const cal = getDeskCalibration(id);
  const stats = sessionStats(id);
  let genome: BrainGenome | null = null;
  try {
    genome = getBrainGenome();
  } catch {
    genome = null;
  }
  return {
    client_id: id,
    enabled: bucket(id).enabled,
    session_started_at: st.started_at,
    closes_in_session: n,
    closes_until_next: st.started_at ? until : AUTO_CALIBRATE_EVERY_N,
    cycles_run: st.cycles_run,
    last_cycle_at: st.last_cycle_at,
    last_summary: st.last_summary,
    last_changes: [...st.last_changes],
    cooling_down: cooling,
    cooldown_until: st.cooldown_until_ms != null ? new Date(st.cooldown_until_ms).toISOString() : null,
    cooldown_left_s: left,
    ...stats,
    last_window_expectancy: st.last_window_expectancy,
    history: st.history.slice(0, 8),
    knobs_now: {
      hardinv_abs: cal.hardinv_abs,
      hardinv_pct: cal.hardinv_pct,
      peak_mfe_abs: cal.peak_mfe_abs,
      peak_retention: cal.peak_retention,
      target_abs: cal.target_abs,
      target_pct: cal.target_pct,
      safety_tp_rr: cal.safety_tp_rr,
      entry_filter_level: cal.entry_filter_level,
      enabled_regimes: cal.enabled_regimes.length,
      genome_peak_keep: genome?.peak_keep ?? 0.75,
      genome_soft_giveback: genome?.soft_plus_giveback ?? 0.75,
      genome_pullback_episode_arm: genome?.pullback_episode_peak_arm_soft_mult ?? 1.0,
    },
  };
}

/**
 * Record one closed trade. Every AUTO_CALIBRATE_EVERY_N closes since START,
 * retunes desk + genome. Applied change starts a short settle before the next
 * auto-cal cycle — entries stay open. Never throws.
 */
export function noteClosedTradeForAutoCalibrate(
  trade: SessionTrade,
  clientId?: number | null
): AutoCalibrateProposeResult | null {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  const b = bucket(id);
  const state = b.state;
  if (!b.enabled) return null;
  if (!state.started_at) {
    beginAutoCalibrateSession('first_close', id);
  }
  let pts = Number(trade.pnl_pts);
  if (!Number.isFinite(pts)) {
    pts = 0;
  }

  state.trades.push({
    ...trade,
    pnl_pts: pts,
    at: trade.at || new Date().toISOString(),
  });
  persistSession(id);

  if (state.trades.length % AUTO_CALIBRATE_EVERY_N !== 0) return null;

  const window = state.trades.slice(-AUTO_CALIBRATE_EVERY_N);
  const current = getDeskCalibration(id);
  let genomeNow: BrainGenome | null = null;
  try {
    genomeNow = getBrainGenome();
  } catch {
    genomeNow = null;
  }
  const proposed = proposeAutoCalibration(current, window, state.demoted, {
    raise_streak: state.raise_streak,
    genome: genomeNow ?? undefined,
  });
  const windowSum = window.reduce((a, t) => a + t.pnl_pts, 0);
  const windowE = window.length ? windowSum / window.length : 0;
  state.last_window_expectancy = windowE;
  const at = new Date().toISOString();

  const pushHistory = (applied: boolean, cooldownSec: number) => {
    state.history.unshift({
      at,
      summary: proposed.summary,
      changes: [...proposed.changes],
      applied,
      window_expectancy: windowE,
      window_sum_pts: windowSum,
      closes_at_cycle: state.trades.length,
      cooldown_sec: cooldownSec,
    });
    if (state.history.length > 12) state.history.length = 12;
  };

  const raisedWinners = proposed.changes.some(
    (c) =>
      /peak_mfe_abs|peak_retention|target_abs|safety_tp_rr|hardinv_abs ease|hardinv_pct ease/.test(
        c
      ) && /→/.test(c) && !/pullback|tighten|ease Peak|ease Target/.test(c)
  );
  const pulledBack = proposed.changes.some(
    (c) => /pullback|ease|tighten|Soft-heavy|protect/.test(c)
  );

  const genomeApplied =
    proposed.genome_patch && Object.keys(proposed.genome_patch).length > 0
      ? (() => {
          try {
            setBrainGenome({
              ...proposed.genome_patch,
              explore_step: (genomeNow?.explore_step ?? 0) + 1,
              last_lesson: proposed.summary.slice(0, 200),
            });
            return true;
          } catch {
            return false;
          }
        })()
      : false;

  const deskApplied = proposed.applied;
  const anyApplied = deskApplied || genomeApplied;

  if (!anyApplied) {
    state.cycles_run += 1;
    state.last_cycle_at = at;
    state.last_summary = proposed.summary;
    state.last_changes = proposed.changes;
    pushHistory(false, 0);
    persistSession(id);
    return proposed;
  }

  if (pulledBack) state.raise_streak = 0;
  else if (raisedWinners) state.raise_streak += 1;
  else state.raise_streak = Math.max(0, state.raise_streak - 1);

  const saved = deskApplied ? setDeskCalibration(proposed.next, id) : current;
  for (const ch of proposed.changes) {
    const m =
      /^WHAT · regime Soft OFF (.+?) ·/.exec(ch) ||
      /^WHAT · regime OFF (.+?) ·/.exec(ch) ||
      /^regime Soft OFF (.+)$/.exec(ch) ||
      /^regime OFF (.+)$/.exec(ch);
    if (m) state.demoted.add(m[1]!.split(' ')[0]!);
    const p = /^WHAT · regime ON (.+?) ·/.exec(ch) || /^regime ON (.+)$/.exec(ch);
    if (p) state.demoted.delete(p[1]!.split(' ')[0]!);
  }
  state.cooldown_until_ms = Date.now() + AUTO_CALIBRATE_COOLDOWN_MS;
  state.cycles_run += 1;
  state.last_cycle_at = at;
  const genomeNote = genomeApplied
    ? ` · genome ${proposed.genome_changes?.length ?? 0}`
    : '';
  state.last_summary = `${proposed.summary}${genomeNote} · cal settle ${AUTO_CALIBRATE_COOLDOWN_MS / 60_000}m (entries OK)`;
  state.last_changes = [
    ...proposed.changes,
    ...(proposed.genome_changes || []),
  ];
  pushHistory(true, AUTO_CALIBRATE_COOLDOWN_MS / 1000);
  persistSession(id);
  return {
    ...proposed,
    applied: true,
    next: saved,
    changes: state.last_changes,
  };
}

function proposeGenomePatch(
  next: DeskCalibration,
  windowTrades: SessionTrade[],
  intent: string,
  softDominates: boolean,
  expectancy: number,
  softLosses: number,
  genome?: BrainGenome | null
): { patch: Partial<BrainGenome>; changes: string[] } {
  const g = genome ?? null;
  const patch: Partial<BrainGenome> = {};
  const changes: string[] = [];
  if (!g) return { patch, changes };

  // Sync Peak Keep with desk retention (genome follows 10%…95%)
  const keepTarget = roundRet(
    Math.min(AUTO_CAL_MAX_PEAK_RETENTION, Math.max(AUTO_CAL_MIN_PEAK_RETENTION, next.peak_retention))
  );
  if (Math.abs(g.peak_keep - keepTarget) >= 0.01) {
    patch.peak_keep = keepTarget;
    changes.push(
      autotuneLog(
        `genome peak_keep ${roundRet(g.peak_keep).toFixed(2)}→${keepTarget.toFixed(2)}`,
        'sync with desk Peak retention'
      )
    );
  }

  if (softDominates || intent === 'protect_sooner') {
    const give = roundRet(Math.min(0.85, Math.max(0.55, g.soft_plus_giveback + 0.03)));
    if (give !== roundRet(g.soft_plus_giveback)) {
      patch.soft_plus_giveback = give;
      changes.push(
        autotuneLog(
          `genome soft_plus_giveback ${roundRet(g.soft_plus_giveback).toFixed(2)}→${give.toFixed(2)}`,
          'Soft-heavy — bank Soft+ sooner'
        )
      );
    }
    const arm = roundRet(Math.min(2.0, Math.max(0.5, g.peak_arm_soft_mult - 0.05)));
    if (arm !== roundRet(g.peak_arm_soft_mult)) {
      patch.peak_arm_soft_mult = arm;
      changes.push(
        autotuneLog(
          `genome peak_arm_soft_mult ${roundRet(g.peak_arm_soft_mult).toFixed(2)}→${arm.toFixed(2)}`,
          'arm Peak earlier after Soft losses'
        )
      );
    }
    const unlock = roundRet(Math.min(1.5, Math.max(0.5, g.soft_layer_unlock_mult + 0.05)));
    if (unlock !== roundRet(g.soft_layer_unlock_mult)) {
      patch.soft_layer_unlock_mult = unlock;
      changes.push(
        autotuneLog(
          `genome soft_layer_unlock_mult ${roundRet(g.soft_layer_unlock_mult).toFixed(2)}→${unlock.toFixed(2)}`,
          'Soft-heavy — harder to unlock fat Soft L2/L3'
        )
      );
    }
    // Soft HardInv after TREND + bounce/dip chapter → tighten pullback-episode Soft×
    const pbSoft = windowTrades.filter((t) => {
      const er = String(t.exit_reason || '');
      if (!/HardInvalidation/i.test(er) && !(Number(t.pnl_pts) < 0)) return false;
      const ch = String(t.exit_ctx?.chapter || t.entry_ctx?.chapter || '').toUpperCase();
      const reg = String(t.regime || '').toUpperCase();
      const bounce =
        ch === 'BOUNCE_IN_SELL' ||
        ch === 'DIP_IN_RALLY' ||
        ch === 'EXHAUST_LO' ||
        ch === 'EXHAUST_HI';
      const trendish =
        reg.includes('TREND') || reg.includes('PULLBACK');
      return bounce || trendish;
    }).length;
    if (pbSoft >= 2) {
      if (!g.pullback_episode_enabled) {
        patch.pullback_episode_enabled = true;
        changes.push(
          autotuneLog(
            'genome pullback_episode_enabled false→true',
            `Soft×${pbSoft} TREND/bounce Soft — enable pullback episode`
          )
        );
      }
      const epArm = roundRet(
        Math.min(1.35, Math.max(0.5, g.pullback_episode_peak_arm_soft_mult - 0.05))
      );
      if (epArm !== roundRet(g.pullback_episode_peak_arm_soft_mult)) {
        patch.pullback_episode_peak_arm_soft_mult = epArm;
        changes.push(
          autotuneLog(
            `genome pullback_episode_peak_arm_soft_mult ${roundRet(g.pullback_episode_peak_arm_soft_mult).toFixed(2)}→${epArm.toFixed(2)}`,
            `Soft×${pbSoft} bounce Soft — Peak Soft× earlier in episode`
          )
        );
      }
      const epMin = roundRet(
        Math.min(1.0, Math.max(0.25, g.pullback_episode_min_mfe_soft_mult - 0.05))
      );
      if (epMin !== roundRet(g.pullback_episode_min_mfe_soft_mult)) {
        patch.pullback_episode_min_mfe_soft_mult = epMin;
        changes.push(
          autotuneLog(
            `genome pullback_episode_min_mfe_soft_mult ${roundRet(g.pullback_episode_min_mfe_soft_mult).toFixed(2)}→${epMin.toFixed(2)}`,
            'sooner Soft+ bank in pullback episode'
          )
        );
      }
    }
    // False RANGE Soft knives — tighten positive RANGE chop gates (harder to call RANGE)
    const rangeSoft = windowTrades.filter((t) => {
      const reg = String(t.regime || '').toUpperCase();
      if (reg !== 'RANGE' && reg !== 'COMPRESSION' && reg !== 'TRANSITION') return false;
      return t.pnl_pts < -1e-9;
    }).length;
    if (rangeSoft >= 2) {
      const persist = roundRet(
        Math.min(0.55, Math.max(0.08, g.regime_range_chop_persist_max - 0.03))
      );
      if (persist !== roundRet(g.regime_range_chop_persist_max)) {
        patch.regime_range_chop_persist_max = persist;
        changes.push(
          autotuneLog(
            `genome regime_range_chop_persist_max ${roundRet(g.regime_range_chop_persist_max).toFixed(2)}→${persist.toFixed(2)}`,
            `RANGE Soft×${rangeSoft} — RANGE only tighter chop`
          )
        );
      }
      const share = roundRet(
        Math.min(0.55, Math.max(0.12, g.regime_range_trek_share_max - 0.03))
      );
      if (share !== roundRet(g.regime_range_trek_share_max)) {
        patch.regime_range_trek_share_max = share;
        changes.push(
          autotuneLog(
            `genome regime_range_trek_share_max ${roundRet(g.regime_range_trek_share_max).toFixed(2)}→${share.toFixed(2)}`,
            'false RANGE Soft — narrower sideway trek for RANGE'
          )
        );
      }
      const eff = roundRet(
        Math.min(0.7, Math.max(0.15, g.regime_range_trek_eff_max - 0.03))
      );
      if (eff !== roundRet(g.regime_range_trek_eff_max)) {
        patch.regime_range_trek_eff_max = eff;
        changes.push(
          autotuneLog(
            `genome regime_range_trek_eff_max ${roundRet(g.regime_range_trek_eff_max).toFixed(2)}→${eff.toFixed(2)}`,
            'false RANGE Soft — lower trek-eff ceiling for RANGE'
          )
        );
      }
    }
    const pause = Math.min(12, g.soft_same_side_pause_closes + 1);
    if (pause !== g.soft_same_side_pause_closes && softLosses >= 2) {
      patch.soft_same_side_pause_closes = pause;
      changes.push(
        autotuneLog(
          `genome soft_same_side_pause_closes ${g.soft_same_side_pause_closes}→${pause}`,
          'pause same-side after Soft chop'
        )
      );
    }
  } else if (intent === 'let_winners_run' || expectancy > 0.25) {
    const arm = roundRet(Math.min(2.0, Math.max(0.5, g.peak_arm_soft_mult + 0.05)));
    if (arm !== roundRet(g.peak_arm_soft_mult)) {
      patch.peak_arm_soft_mult = arm;
      changes.push(
        autotuneLog(
          `genome peak_arm_soft_mult ${roundRet(g.peak_arm_soft_mult).toFixed(2)}→${arm.toFixed(2)}`,
          'let winners run — Peak arms later'
        )
      );
    }
    const unlockEase = roundRet(Math.min(1.5, Math.max(0.5, g.soft_layer_unlock_mult - 0.05)));
    if (unlockEase !== roundRet(g.soft_layer_unlock_mult)) {
      patch.soft_layer_unlock_mult = unlockEase;
      changes.push(
        autotuneLog(
          `genome soft_layer_unlock_mult ${roundRet(g.soft_layer_unlock_mult).toFixed(2)}→${unlockEase.toFixed(2)}`,
          'winners — easier Soft L2/L3 unlock for runners'
        )
      );
    }
    const epArmUp = roundRet(
      Math.min(1.35, Math.max(0.5, g.pullback_episode_peak_arm_soft_mult + 0.05))
    );
    if (
      g.pullback_episode_enabled &&
      epArmUp !== roundRet(g.pullback_episode_peak_arm_soft_mult) &&
      epArmUp <= roundRet(g.peak_arm_soft_mult)
    ) {
      patch.pullback_episode_peak_arm_soft_mult = epArmUp;
      changes.push(
        autotuneLog(
          `genome pullback_episode_peak_arm_soft_mult ${roundRet(g.pullback_episode_peak_arm_soft_mult).toFixed(2)}→${epArmUp.toFixed(2)}`,
          'winners — episode Peak Soft× a bit later'
        )
      );
    }
    // Winning RANGE fades — ease positive RANGE gates slightly (more true chop OK)
    const rangeWins = windowTrades.filter((t) => {
      const reg = String(t.regime || '').toUpperCase();
      return (
        (reg === 'RANGE' || reg === 'COMPRESSION') &&
        t.pnl_pts > 1e-9 &&
        /PeakProtection|MindBank|Target|TimeDecay/i.test(String(t.exit_reason || ''))
      );
    }).length;
    if (rangeWins >= 2) {
      const persist = roundRet(
        Math.min(0.55, Math.max(0.08, g.regime_range_chop_persist_max + 0.02))
      );
      if (persist !== roundRet(g.regime_range_chop_persist_max)) {
        patch.regime_range_chop_persist_max = persist;
        changes.push(
          autotuneLog(
            `genome regime_range_chop_persist_max ${roundRet(g.regime_range_chop_persist_max).toFixed(2)}→${persist.toFixed(2)}`,
            `RANGE wins×${rangeWins} — ease chop gate`
          )
        );
      }
    }
    const runner = roundRet(Math.min(2.0, Math.max(1.0, g.soft_plus_runner_mult + 0.05)));
    if (runner !== roundRet(g.soft_plus_runner_mult)) {
      patch.soft_plus_runner_mult = runner;
      changes.push(
        autotuneLog(
          `genome soft_plus_runner_mult ${roundRet(g.soft_plus_runner_mult).toFixed(2)}→${runner.toFixed(2)}`,
          'Soft+ bank later — runners breathe'
        )
      );
    }
    const leg = roundRet(Math.min(2.0, Math.max(1.0, g.soft_plus_leg_mult + 0.05)));
    if (leg !== roundRet(g.soft_plus_leg_mult)) {
      patch.soft_plus_leg_mult = leg;
      changes.push(
        autotuneLog(
          `genome soft_plus_leg_mult ${roundRet(g.soft_plus_leg_mult).toFixed(2)}→${leg.toFixed(2)}`,
          'Soft+ leg later — no Soft×1 ceiling'
        )
      );
    }
  }

  // Market context — choppy / mixed pressure → loosen trek / story bar slightly
  const choppyCtx = windowTrades.filter((t) => {
    const ctx = t.exit_ctx || t.entry_ctx;
    if (!ctx) return false;
    const midShare = ctx.green_share > 0.35 && ctx.green_share < 0.65;
    return midShare && !ctx.expanding;
  }).length;
  if (choppyCtx >= 2 && expectancy < 0.1) {
    // Trek flat is bp (min 0.1) — step 0.1, never 0.00008 dust
    const trek =
      Math.round(Math.min(12, Math.max(1.5, g.mtf_trek_flat_frac * 1.08)) * 10) / 10;
    if (Math.abs(trek - g.mtf_trek_flat_frac) > 0.05) {
      patch.mtf_trek_flat_frac = trek;
      changes.push(
        autotuneLog(
          `genome mtf_trek_flat_frac ${g.mtf_trek_flat_frac.toFixed(1)}→${trek.toFixed(1)} bp`,
          `choppy pressure ×${choppyCtx} — wider FLAT trek`
        )
      );
    }
    const storyMin = roundRet(Math.min(0.8, Math.max(0.35, g.entry_story_conf_min - 0.03)));
    if (storyMin !== roundRet(g.entry_story_conf_min)) {
      patch.entry_story_conf_min = storyMin;
      changes.push(
        autotuneLog(
          `genome entry_story_conf_min ${roundRet(g.entry_story_conf_min).toFixed(2)}→${storyMin.toFixed(2)}`,
          'allow slightly weaker story when chop dominates'
        )
      );
    }
  }

  // Bad expectancy + multi-TF fights in context → require aligned side
  if (expectancy < -0.2 && !g.mtf_require_aligned_side) {
    patch.mtf_require_aligned_side = true;
    changes.push(
      autotuneLog(
        'genome mtf_require_aligned_side false→true',
        'negative E — demand multi-TF alignment'
      )
    );
  }

  // Expanding market pressure → slightly faster regime confirm (self-build perception)
  const expandingCtx = windowTrades.filter((t) => (t.exit_ctx || t.entry_ctx)?.expanding).length;
  if (expandingCtx >= 3 && expectancy > 0.15) {
    const confirm = Math.max(1, Math.min(8, g.regime_confirm_bars - 1));
    if (confirm !== g.regime_confirm_bars) {
      patch.regime_confirm_bars = confirm;
      changes.push(
        autotuneLog(
          `genome regime_confirm_bars ${g.regime_confirm_bars}→${confirm}`,
          `expanding market ×${expandingCtx} — faster regime confirm`
        )
      );
    }
  } else if (choppyCtx >= 2 && expectancy < 0) {
    const dwell = Math.max(2, Math.min(12, g.regime_min_dwell_bars + 1));
    if (dwell !== g.regime_min_dwell_bars) {
      patch.regime_min_dwell_bars = dwell;
      changes.push(
        autotuneLog(
          `genome regime_min_dwell_bars ${g.regime_min_dwell_bars}→${dwell}`,
          `choppy ×${choppyCtx} — longer dwell before regime switch`
        )
      );
    }
  }

  // Fight feed disagreement → HTF veto on
  const fightCtx = windowTrades.filter((t) => {
    const a = (t.exit_ctx || t.entry_ctx)?.feed_agreement;
    return a === 'FIGHT' || a === 'fight' || a === 'DISAGREE';
  }).length;
  if (fightCtx >= 2 && expectancy < 0.05 && !g.mtf_htf_veto) {
    patch.mtf_htf_veto = true;
    changes.push(
      autotuneLog('genome mtf_htf_veto false→true', `feed fight ×${fightCtx} — HTF veto on`)
    );
  }

  return { patch, changes };
}

/** Pure propose — unit-tested without disk. */
export function proposeAutoCalibration(
  current: DeskCalibration,
  windowTrades: SessionTrade[],
  demotedSession: Set<string> = new Set(),
  opts?: { raise_streak?: number; genome?: BrainGenome | null }
): AutoCalibrateProposeResult {
  const raiseStreak = Math.max(0, Number(opts?.raise_streak) || 0);
  const changes: string[] = [];
  if (!windowTrades.length) {
    return {
      applied: false,
      summary: 'No trades in window',
      changes: [],
      next: current,
    };
  }

  const pts = windowTrades.map((t) => t.pnl_pts);
  const sum = pts.reduce((a, b) => a + b, 0);
  const wins = pts.filter((p) => p > 1e-9);
  const losses = pts.filter((p) => p < -1e-9);
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLossAbs = losses.length
    ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length)
    : 0;
  const expectancy = sum / windowTrades.length;
  const softLosses = windowTrades.filter(
    (t) =>
      /HardInvalidation|HardInv/i.test(summarizeExitReason(t.exit_reason)) &&
      t.pnl_pts < -1e-9 &&
      Math.abs(t.pnl_pts) >= Math.max(1.0, current.hardinv_abs * 0.65)
  ).length;
  /** Soft-sized cuts even when exit_reason is MindCut/Structure/EXTERNAL — still Soft R:R. */
  const softSizedLosses = windowTrades.filter(
    (t) =>
      t.pnl_pts < -1e-9 &&
      Math.abs(t.pnl_pts) >= Math.max(1.0, current.hardinv_abs * 0.65)
  ).length;
  const microWins = windowTrades.filter(
    (t) => t.pnl_pts > 1e-9 && t.pnl_pts < Math.max(1.0, avgLossAbs * 0.45)
  ).length;

  const peakExits = windowTrades.filter((t) =>
    /PeakProtection|MindBank|MindCut|TimeDecay|Target/i.test(String(t.exit_reason || ''))
  );
  const highMfeTinyPnl = windowTrades.filter(
    (t) => t.mfe > 0 && t.pnl_pts > 0 && t.pnl_pts < t.mfe * 0.35 && t.mfe >= avgLossAbs * 0.8
  ).length;
  const leftWinnerOnTable =
    peakExits.length >= 2 && highMfeTinyPnl >= 2 && expectancy < 0.2;

  const human = reviewSessionLikeHuman(windowTrades);
  changes.push(`PRĀTS · ${human.diagnosis}`);
  changes.push(`MĀCĪBA · ${human.lesson}`);

  const next: DeskCalibration = {
    ...current,
    enabled_regimes: [...current.enabled_regimes],
    soft_off_regimes: [...(current.soft_off_regimes || [])],
  };

  const rrNow = next.safety_tp_rr || 1.5;
  const alreadyTall =
    rrNow >= AUTO_CAL_MAX_SAFETY_TP_RR - 0.01 ||
    next.target_abs >= AUTO_CAL_MAX_TARGET_ABS - 0.01 ||
    next.peak_mfe_abs >= AUTO_CAL_MAX_PEAK_MFE_ABS - 0.01 ||
    next.target_abs >= next.hardinv_abs * 2.8;

  const asymmetryBad =
    avgWin > 0 && avgLossAbs > 0 && avgWin < avgLossAbs * 0.85 && microWins >= 2;

  const softDominates =
    expectancy < 0.05 &&
    avgLossAbs >= 1.0 &&
    (wins.length === 0 || avgWin < avgLossAbs * 0.75) &&
    (softLosses >= 2 ||
      softSizedLosses >= 2 ||
      (losses.length >= 3 && avgLossAbs >= current.hardinv_abs * 0.7));

  const needPullBack =
    human.intent === 'ease_peak_target' ||
    softDominates ||
    (expectancy < 0.05 &&
      (raiseStreak >= AUTO_CAL_RAISE_STREAK_BEFORE_PULLBACK ||
        alreadyTall ||
        leftWinnerOnTable ||
        (asymmetryBad && (softLosses >= 2 || softSizedLosses >= 2))));

  const needProtectSooner =
    human.intent === 'protect_sooner' || human.intent === 'tighten_filters';
  const needTightenFilters = human.intent === 'tighten_filters';
  const needEaseFilters =
    human.intent === 'ease_filters' ||
    (human.intent === 'let_winners_run' && (current.entry_filter_level || 0) > 0 && expectancy >= 0.5);

  const needBiggerWinners =
    !needPullBack &&
    !needProtectSooner &&
    human.intent === 'let_winners_run' &&
    !alreadyTall &&
    raiseStreak < AUTO_CAL_RAISE_STREAK_BEFORE_PULLBACK;

  const needBiggerWinnersLegacy =
    !needPullBack &&
    !needProtectSooner &&
    human.intent === 'hold_course' &&
    !alreadyTall &&
    raiseStreak < AUTO_CAL_RAISE_STREAK_BEFORE_PULLBACK &&
    (expectancy < 0.15 ||
      (avgWin > 0 && avgLossAbs > 0 && avgWin < avgLossAbs * 0.9) ||
      microWins >= 2);

  const doRaise = needBiggerWinners || needBiggerWinnersLegacy;

  // Soft too tight: many Soft cuts but avg Soft distance looks small vs MFE left on table
  const softTooTight =
    !softDominates &&
    softLosses >= 2 &&
    highMfeTinyPnl >= 1 &&
    expectancy < 0.15 &&
    next.hardinv_abs <= 2.0;

  if (needPullBack) {
    // Soft-heavy — tighten Soft CAP + pct so Soft chops cost less (live Soft follows both)
    if (softDominates) {
      const softBefore = next.hardinv_abs;
      next.hardinv_abs = Math.max(AUTO_CAL_MIN_HARDINV_ABS, roundAbs(softBefore - 0.2));
      next.hardinv_abs = Math.min(AUTO_CAL_MAX_HARDINV_ABS, next.hardinv_abs);
      next.hardinv_pct = softPctFromAbs(next.hardinv_abs);
      if (next.hardinv_abs !== softBefore) {
        const mkt = windowTrades
          .map((t) => (t.exit_ctx || t.entry_ctx)?.chapter)
          .filter(Boolean)
          .slice(0, 2)
          .join('/');
        changes.push(
          autotuneLog(
            `hardinv_abs ${softBefore.toFixed(1)}→${next.hardinv_abs.toFixed(1)} Soft tighten`,
            `Soft-heavy SoftTag×${softLosses} SoftSized×${softSizedLosses} E=${expectancy.toFixed(2)} avgL=${avgLossAbs.toFixed(1)}${
              mkt ? ` · mkt ${mkt}` : ''
            }`
          )
        );
      }
    }

    const rrBefore = next.safety_tp_rr || 1.5;
    next.safety_tp_rr = Math.max(1.5, roundRr(rrBefore - 0.25));
    if (next.safety_tp_rr !== rrBefore) {
      changes.push(
        autotuneLog(
          `safety_tp_rr ${rrBefore.toFixed(2)}→${next.safety_tp_rr.toFixed(2)} pullback`,
          'targets overreached vs Soft — shrink broker TP RR'
        )
      );
    }
    const peakBefore = next.peak_mfe_abs;
    const retBefore = next.peak_retention;
    const tgtBefore = next.target_abs;
    const easedPeak = roundAbs(next.peak_mfe_abs - 0.5);
    const peakFloor = roundAbs(next.hardinv_abs + 0.5);
    next.peak_mfe_abs = easedPeak >= peakFloor ? easedPeak : peakBefore;
    if (softDominates) {
      next.peak_retention = roundRet(
        Math.min(AUTO_CAL_MAX_PEAK_RETENTION, Math.max(retBefore, retBefore + 0.04))
      );
    } else {
      next.peak_retention = roundRet(
        Math.max(AUTO_CAL_MIN_PEAK_RETENTION, next.peak_retention - 0.05)
      );
    }
    next.peak_min_giveback_abs = roundAbs(Math.max(0.5, next.peak_min_giveback_abs - 0.15));
    const easedTgt = roundAbs(next.target_abs - 1.2);
    const tgtFloor = roundAbs(next.hardinv_abs + 1.5);
    next.target_abs = easedTgt >= tgtFloor ? easedTgt : tgtBefore;
    next.target_pct = roundPct(Math.max(AUTO_CAL_MIN_TARGET_PCT, next.target_pct / 1.12));
    if (next.peak_mfe_abs !== peakBefore) {
      changes.push(
        autotuneLog(
          `peak_mfe_abs ${peakBefore.toFixed(1)}→${next.peak_mfe_abs.toFixed(1)} ease`,
          'bank earlier — Peak floor Soft+0.5'
        )
      );
    }
    if (next.peak_retention !== retBefore) {
      changes.push(
        autotuneLog(
          `peak_retention ${retBefore.toFixed(2)}→${next.peak_retention.toFixed(2)} ${
            softDominates ? 'protect-sooner' : 'ease'
          }`,
          softDominates ? 'Soft eats winners — keep more of Peak MFE' : 'ease Keep for room'
        )
      );
    }
    if (next.target_abs !== tgtBefore) {
      changes.push(
        autotuneLog(
          `target_abs ${tgtBefore.toFixed(1)}→${next.target_abs.toFixed(1)} ease`,
          'Target nearer Soft so winners bank'
        )
      );
    }
    // target_pct tracks abs silently — no 0.000xx WHAT spam
  } else if (needProtectSooner) {
    const retBefore = next.peak_retention;
    // Protect sooner = keep MORE of MFE (higher Keep), free within 10%…95%
    next.peak_retention = roundRet(
      Math.min(AUTO_CAL_MAX_PEAK_RETENTION, next.peak_retention + 0.05)
    );
    if (next.peak_retention !== retBefore) {
      changes.push(
        autotuneLog(
          `peak_retention ${retBefore.toFixed(2)}→${next.peak_retention.toFixed(2)} protect-sooner`,
          'PRĀTS: protect winners sooner — raise Peak Keep'
        )
      );
    }
  } else if (doRaise) {
    // Soft may ease slightly so winners have room (Soft+HardInv free)
    if (softTooTight || human.intent === 'let_winners_run') {
      const softBefore = next.hardinv_abs;
      next.hardinv_abs = Math.min(AUTO_CAL_MAX_HARDINV_ABS, roundAbs(softBefore + 0.2));
      next.hardinv_pct = softPctFromAbs(next.hardinv_abs);
      if (next.hardinv_abs !== softBefore) {
        changes.push(
          autotuneLog(
            `hardinv_abs ${softBefore.toFixed(1)}→${next.hardinv_abs.toFixed(1)} Soft ease`,
            'give Soft room so winners are not Soft-chopped'
          )
        );
      }
    }
    const rrBefore = next.safety_tp_rr || 1.5;
    next.safety_tp_rr = Math.min(AUTO_CAL_MAX_SAFETY_TP_RR, roundRr(rrBefore + 0.15));
    if (next.safety_tp_rr !== rrBefore) {
      changes.push(
        autotuneLog(
          `safety_tp_rr ${rrBefore.toFixed(2)}→${next.safety_tp_rr.toFixed(2)}`,
          'let winners run — raise broker TP RR'
        )
      );
    }
    const peakBefore = next.peak_mfe_abs;
    const retBefore = next.peak_retention;
    const tgtBefore = next.target_abs;
    next.peak_mfe_abs = Math.min(AUTO_CAL_MAX_PEAK_MFE_ABS, roundAbs(next.peak_mfe_abs + 0.4));
    next.peak_retention = roundRet(
      Math.min(AUTO_CAL_MAX_PEAK_RETENTION, next.peak_retention + 0.03)
    );
    next.peak_min_giveback_abs = roundAbs(Math.min(2.0, next.peak_min_giveback_abs + 0.1));
    next.target_abs = Math.min(AUTO_CAL_MAX_TARGET_ABS, roundAbs(next.target_abs + 0.8));
    next.target_pct = roundPct(Math.min(AUTO_CAL_MAX_TARGET_PCT, next.target_pct * 1.06));
    next.peak_mfe_pct = roundPct(Math.min(AUTO_CAL_MAX_PEAK_MFE_PCT, next.peak_mfe_pct * 1.05));
    if (next.peak_mfe_abs !== peakBefore) {
      changes.push(
        autotuneLog(
          `peak_mfe_abs ${peakBefore.toFixed(1)}→${next.peak_mfe_abs.toFixed(1)}`,
          'raise Peak arm for bigger winners'
        )
      );
    }
    if (next.peak_retention !== retBefore) {
      changes.push(
        autotuneLog(
          `peak_retention ${retBefore.toFixed(2)}→${next.peak_retention.toFixed(2)}`,
          'keep more of Peak MFE'
        )
      );
    }
    if (next.target_abs !== tgtBefore) {
      changes.push(
        autotuneLog(
          `target_abs ${tgtBefore.toFixed(1)}→${next.target_abs.toFixed(1)}`,
          'raise Soft Target'
        )
      );
    }
    // target_pct / peak_mfe_pct track abs silently — no 0.000xx WHAT spam
  }

  // Soft ease when too tight even without full raise path
  if (!needPullBack && !doRaise && softTooTight) {
    const softBefore = next.hardinv_abs;
    next.hardinv_abs = Math.min(AUTO_CAL_MAX_HARDINV_ABS, roundAbs(softBefore + 0.2));
    next.hardinv_pct = softPctFromAbs(next.hardinv_abs);
    if (next.hardinv_abs !== softBefore) {
      changes.push(
        autotuneLog(
          `hardinv_abs ${softBefore.toFixed(1)}→${next.hardinv_abs.toFixed(1)} Soft ease`,
          'Soft too tight vs MFE left on table'
        )
      );
    }
  }

  // Healthy polish
  if (
    !doRaise &&
    !needPullBack &&
    !needProtectSooner &&
    expectancy >= 0.3 &&
    avgWin >= avgLossAbs * 0.95 &&
    wins.length >= losses.length
  ) {
    const retBefore = next.peak_retention;
    next.peak_retention = roundRet(
      Math.min(AUTO_CAL_MAX_PEAK_RETENTION, next.peak_retention + 0.01)
    );
    if (next.peak_retention !== retBefore) {
      changes.push(
        autotuneLog(
          `peak_retention ${retBefore.toFixed(2)}→${next.peak_retention.toFixed(2)} hold+`,
          'healthy window — tiny Keep polish'
        )
      );
    }
  }

  // Peak above Soft CAP (never raise during pullback)
  if (!needPullBack) {
    if (next.peak_mfe_abs <= next.hardinv_abs + 0.5) {
      const b = next.peak_mfe_abs;
      next.peak_mfe_abs = Math.min(AUTO_CAL_MAX_PEAK_MFE_ABS, roundAbs(next.hardinv_abs + 1.5));
      if (next.peak_mfe_abs !== b) {
        changes.push(
          autotuneLog(
            `peak_mfe_abs ${b.toFixed(1)}→${next.peak_mfe_abs.toFixed(1)} floor vs Soft`,
            'Peak must sit above Soft CAP'
          )
        );
      }
    }
    if (next.target_abs <= next.hardinv_abs + 1) {
      const b = next.target_abs;
      next.target_abs = Math.min(AUTO_CAL_MAX_TARGET_ABS, roundAbs(next.hardinv_abs + 3));
      if (next.target_abs !== b) {
        changes.push(
          autotuneLog(
            `target_abs ${b.toFixed(1)}→${next.target_abs.toFixed(1)} floor vs Soft`,
            'Target must sit above Soft CAP'
          )
        );
      }
    }
  }

  // Clamp overshoot
  if (next.safety_tp_rr > AUTO_CAL_MAX_SAFETY_TP_RR) {
    const b = next.safety_tp_rr;
    next.safety_tp_rr = AUTO_CAL_MAX_SAFETY_TP_RR;
    changes.push(
      autotuneLog(
        `safety_tp_rr ${b.toFixed(2)}→${next.safety_tp_rr.toFixed(2)} cap`,
        'auto-cal max TP RR'
      )
    );
  }
  if (next.target_abs > AUTO_CAL_MAX_TARGET_ABS) {
    const b = next.target_abs;
    next.target_abs = AUTO_CAL_MAX_TARGET_ABS;
    changes.push(
      autotuneLog(`target_abs ${b.toFixed(1)}→${next.target_abs.toFixed(1)} cap`, 'auto-cal max Target')
    );
  }
  if (next.peak_mfe_abs > AUTO_CAL_MAX_PEAK_MFE_ABS) {
    const b = next.peak_mfe_abs;
    next.peak_mfe_abs = AUTO_CAL_MAX_PEAK_MFE_ABS;
    changes.push(
      autotuneLog(`peak_mfe_abs ${b.toFixed(1)}→${next.peak_mfe_abs.toFixed(1)} cap`, 'auto-cal max Peak')
    );
  }
  if (next.peak_retention > AUTO_CAL_MAX_PEAK_RETENTION) {
    const b = next.peak_retention;
    next.peak_retention = AUTO_CAL_MAX_PEAK_RETENTION;
    changes.push(
      autotuneLog(
        `peak_retention ${b.toFixed(2)}→${next.peak_retention.toFixed(2)} cap`,
        'auto-cal max Keep'
      )
    );
  }
  if (next.peak_retention < AUTO_CAL_MIN_PEAK_RETENTION) {
    const b = next.peak_retention;
    next.peak_retention = AUTO_CAL_MIN_PEAK_RETENTION;
    changes.push(
      autotuneLog(
        `peak_retention ${b.toFixed(2)}→${next.peak_retention.toFixed(2)} floor`,
        'auto-cal min Keep 10%'
      )
    );
  }
  next.hardinv_abs = Math.min(
    AUTO_CAL_MAX_HARDINV_ABS,
    Math.max(AUTO_CAL_MIN_HARDINV_ABS, next.hardinv_abs)
  );
  // Soft pct always follows Soft abs (clean 0.0001 steps) — never *1.05 dust
  next.hardinv_pct = Math.min(
    AUTO_CAL_MAX_HARDINV_PCT,
    Math.max(AUTO_CAL_MIN_HARDINV_PCT, softPctFromAbs(next.hardinv_abs))
  );

  // Entry filters L0–L3 — full freedom (tighten on knife/chop, ease when winning)
  {
    const b = Math.max(0, Math.min(3, Math.round(Number(next.entry_filter_level) || 0)));
    let lvl = b;
    if (needTightenFilters && lvl < 3) {
      lvl = Math.min(3, lvl + 1);
      changes.push(
        autotuneLog(
          `entry_filter_level ${b}→${lvl}`,
          'knife/chop Soft entries — tighten FLIP/structure filters'
        )
      );
    } else if (needEaseFilters && lvl > 0) {
      lvl = Math.max(0, lvl - 1);
      changes.push(
        autotuneLog(
          `entry_filter_level ${b}→${lvl}`,
          'positive window — ease filters toward OPEN'
        )
      );
    }
    next.entry_filter_level = lvl;
  }

  // --- Regime book: any regime may demote with evidence; floor keeps trading ---
  const byRegime = new Map<string, { sum: number; n: number }>();
  for (const t of windowTrades) {
    const r = String(t.regime || 'UNKNOWN').toUpperCase();
    if (r === 'UNKNOWN') continue;
    const cur = byRegime.get(r) || { sum: 0, n: 0 };
    cur.sum += t.pnl_pts;
    cur.n += 1;
    byRegime.set(r, cur);
  }

  let enabled = new Set(next.enabled_regimes.map((r) => String(r).toUpperCase()));
  let softOff = new Set(
    (next.soft_off_regimes || []).map((r) => String(r).toUpperCase())
  );

  for (const [r, st] of byRegime) {
    if (st.n >= 1 && st.sum > 0.4 && !enabled.has(r)) {
      enabled.add(r);
      softOff.delete(r);
      demotedSession.delete(r);
      changes.push(autotuneLog(`regime ON ${r}`, `winner sum=${st.sum.toFixed(1)} n=${st.n}`));
    }
  }

  let demotedThisCycle: string | null = null;
  // Prefer satellites first; cores only with stronger evidence (n≥2, sum<-0.8)
  const offenders = [...byRegime.entries()]
    .filter(([r, st]) => {
      if (st.n < 2 || st.sum >= -0.35) return false;
      if (isCoreAlwaysOnRegime(r)) return st.sum < -0.8;
      return true;
    })
    .sort((a, b) => {
      const aCore = isCoreAlwaysOnRegime(a[0]) ? 1 : 0;
      const bCore = isCoreAlwaysOnRegime(b[0]) ? 1 : 0;
      if (aCore !== bCore) return aCore - bCore;
      return a[1].sum - b[1].sum;
    });
  if (offenders.length && enabled.size > MIN_ENABLED_REGIMES) {
    const worst = offenders[0]![0];
    if (enabled.has(worst) && enabled.size - 1 >= MIN_ENABLED_REGIMES) {
      enabled.delete(worst);
      demotedSession.add(worst);
      demotedThisCycle = worst;
      softOff.add(worst);
      const coreNote = isCoreAlwaysOnRegime(worst) ? ' (was preferred)' : '';
      changes.push(
        autotuneLog(
          `regime Soft OFF ${worst}${coreNote}`,
          `loser sum=${byRegime.get(worst)!.sum.toFixed(1)} n=${byRegime.get(worst)!.n} · strong signal may still enter`
        )
      );
    }
  }

  if ((expectancy > 0.1 || !demotedThisCycle) && demotedSession.size) {
    const candidate = [...demotedSession].find((r) => r !== demotedThisCycle);
    if (candidate && !enabled.has(candidate)) {
      enabled.add(candidate);
      softOff.delete(candidate);
      demotedSession.delete(candidate);
      changes.push(
        autotuneLog(`regime ON ${candidate}`, 're-promote after positive/flat cycle')
      );
    }
  }

  // Floor: never starve — refill from tradable defaults
  if (enabled.size < MIN_ENABLED_REGIMES) {
    for (const r of tradableDefaultRegimes()) {
      if (enabled.size >= MIN_ENABLED_REGIMES) break;
      if (!enabled.has(r)) {
        enabled.add(r);
        softOff.delete(r);
        changes.push(autotuneLog(`regime ON ${r}`, 'floor — keep trading possible'));
      }
    }
  }

  // Soft OFF cannot overlap ON
  for (const r of enabled) softOff.delete(r);

  next.enabled_regimes = [...enabled] as RegimeName[];
  next.soft_off_regimes = [...softOff] as RegimeName[];

  // Snap all numeric knobs to clean decimals — real steps, no float dust
  next.hardinv_abs = roundAbs(next.hardinv_abs);
  next.peak_mfe_abs = roundAbs(next.peak_mfe_abs);
  next.target_abs = roundAbs(next.target_abs);
  next.peak_min_giveback_abs = roundAbs(next.peak_min_giveback_abs);
  next.peak_retention = roundRet(next.peak_retention);
  next.safety_tp_rr = roundRr(next.safety_tp_rr);
  next.hardinv_pct = Math.min(
    AUTO_CAL_MAX_HARDINV_PCT,
    Math.max(AUTO_CAL_MIN_HARDINV_PCT, softPctFromAbs(next.hardinv_abs))
  );
  next.target_pct = roundPct(next.target_pct);
  next.peak_mfe_pct = roundPct(next.peak_mfe_pct);

  // Soft×3 + Target×3 — calibrate L1/L2 from MFE/Soft-loss; L3 stays tuned hardinv/target
  {
    const before = readSoftTargetLayers(next);
    const mfes = windowTrades.map((t) => Math.max(0, Number(t.mfe) || 0));
    const lossAbs = windowTrades
      .filter((t) => t.pnl_pts < -1e-9)
      .map((t) => Math.abs(t.pnl_pts));
    const suggested = suggestLayersFromExcursions(mfes, lossAbs, before);
    const softL3 = roundAbs(next.hardinv_abs);
    const tgtL3 = roundAbs(next.target_abs);
    let softL1 = roundAbs(before.soft[0]! * 0.55 + suggested.soft[0]! * 0.45);
    let softL2 = roundAbs(before.soft[1]! * 0.55 + suggested.soft[1]! * 0.45);
    softL1 = Math.min(softL1, softL3);
    softL2 = Math.min(Math.max(softL2, softL1), softL3);
    let tgtL1 = roundAbs(before.target[0]! * 0.55 + suggested.target[0]! * 0.45);
    let tgtL2 = roundAbs(before.target[1]! * 0.55 + suggested.target[1]! * 0.45);
    tgtL1 = Math.max(Math.min(tgtL1, tgtL3), softL1);
    tgtL2 = Math.max(Math.min(Math.max(tgtL2, tgtL1), tgtL3), softL2);
    next.soft_l1_abs = softL1;
    next.soft_l2_abs = softL2;
    next.soft_l3_abs = softL3;
    next.hardinv_abs = softL3;
    next.target_l1_abs = tgtL1;
    next.target_l2_abs = tgtL2;
    next.target_l3_abs = tgtL3;
    next.target_abs = tgtL3;
    if (
      next.soft_l1_abs !== before.soft[0] ||
      next.soft_l2_abs !== before.soft[1] ||
      next.target_l1_abs !== before.target[0] ||
      next.target_l2_abs !== before.target[1]
    ) {
      changes.push(
        autotuneLog(
          `Soft layers ${before.soft[0]!.toFixed(1)}/${before.soft[1]!.toFixed(1)}/${before.soft[2]!.toFixed(1)}→${next.soft_l1_abs.toFixed(1)}/${next.soft_l2_abs.toFixed(1)}/${next.soft_l3_abs.toFixed(1)} · Target ${before.target[0]!.toFixed(1)}/${before.target[1]!.toFixed(1)}/${before.target[2]!.toFixed(1)}→${next.target_l1_abs.toFixed(1)}/${next.target_l2_abs.toFixed(1)}/${next.target_l3_abs.toFixed(1)}`,
          '3 Soft + 3 Target — L1/L2 from MFE/Soft-loss · L3 = Soft CAP / Target CAP'
        )
      );
    }
  }

  const genomeResult = proposeGenomePatch(
    next,
    windowTrades,
    human.intent,
    softDominates,
    expectancy,
    softLosses,
    opts?.genome
  );

  const paramOrRegimeChanged = deskCalibrationMateriallyChanged(current, next);
  const genomeChanged = Object.keys(genomeResult.patch).length > 0;
  const summary =
    `n=${windowTrades.length} E=${expectancy.toFixed(2)} ` +
    `W/L=${wins.length}/${losses.length} avgW=${avgWin.toFixed(2)} avgL=${avgLossAbs.toFixed(2)}` +
    (paramOrRegimeChanged || genomeChanged
      ? ` · ${changes.length + genomeResult.changes.length} tweaks`
      : ' · hold');

  return {
    applied: paramOrRegimeChanged,
    summary,
    changes,
    next,
    genome_patch: genomeChanged ? genomeResult.patch : undefined,
    genome_changes: genomeChanged ? genomeResult.changes : undefined,
  };
}

/** Test helper — wipe session state. */
export function _resetAutoCalibrateForTests(clientId: number = 0): void {
  const id = resolveDeskClientId(clientId);
  const b = bucket(id);
  b.enabled = true;
  b.hydrated = true;
  b.state = emptyState();
  try {
    const file = sessionPath(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
  for (const other of [0, 1, 2, 7, 99]) {
    if (other === id) continue;
    if (buckets.has(other)) {
      const ob = bucket(other);
      ob.enabled = true;
      ob.hydrated = true;
      ob.state = emptyState();
    }
  }
}
