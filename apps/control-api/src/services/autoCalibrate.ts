/**
 * Ultimate desk auto-calibrate — watches closes since robot START and
 * softly retunes Soft/Peak/Target + entry_filter_level + regime allowlist
 * every N closes.
 *
 * Soft by design: never daily/% entry blocks, never empty allowlist,
 * never starve below MIN_ENABLED_REGIMES; core regimes never auto-OFF.
 * Lot size untouched.
 * Entry filters start OPEN (0); auto-cal raises after bad closes.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getDeskCalibration,
  setDeskCalibration,
  tradableDefaultRegimes,
  type DeskCalibration,
} from './deskCalibration.js';
import { summarizeExitReason } from './tradeLedger.js';
import type { RegimeName } from './regimes.js';
import { resolveDeskClientId } from './deskClientScope.js';

export const AUTO_CALIBRATE_EVERY_N = 5;
/** After an applied calibrate — pause NEW entries so desk can settle setups. */
export const AUTO_CALIBRATE_COOLDOWN_MS = 3 * 60_000;
/** Never drop below this many regimes — entries stay possible. */
export const MIN_ENABLED_REGIMES = 5;

/**
 * Core liquid regimes — auto-cal NEVER turns these OFF.
 * Demoting RANGE/TREND left only rare BREAKOUT_* → robot starves.
 * Satellite regimes (BREAKOUT / FAILED / REVERSAL) may still soft-demote.
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
  /** True while post-change cooldown blocks new entries */
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
    peak_mfe_abs: number;
    peak_retention: number;
    target_abs: number;
    safety_tp_rr: number;
    entry_filter_level: number;
    enabled_regimes: number;
  };
};

export type AutoCalibrateProposeResult = {
  applied: boolean;
  summary: string;
  changes: string[];
  next: DeskCalibration;
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
  } catch {
    /* ignore corrupt disk */
  }
}

function ensureCoreRegimesOn(clientId?: number | null): void {
  const id = resolveDeskClientId(clientId);
  try {
    const cur = getDeskCalibration(id);
    const have = new Set(cur.enabled_regimes.map((r) => String(r).toUpperCase()));
    let changed = false;
    for (const r of CORE_ALWAYS_ON_REGIMES) {
      if (!have.has(r)) {
        have.add(r);
        changed = true;
      }
    }
    if (changed) {
      setDeskCalibration({ enabled_regimes: [...have] as never }, id);
    }
  } catch {
    /* ignore */
  }
}

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

/** Explicit reset (manual / operator). Clears watch + reopens entry filters. */
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
  st.last_summary = `Session start · client ${id} · ${reason} · entry filters OPEN`;
  st.last_changes = [];
  st.demoted.clear();
  st.cooldown_until_ms = null;
  st.last_window_expectancy = null;
  st.history = [];
  try {
    const cur = getDeskCalibration(id);
    if ((cur.entry_filter_level || 0) !== 0) {
      setDeskCalibration({ entry_filter_level: 0 }, id);
    }
  } catch {
    /* ignore */
  }
  ensureCoreRegimesOn(id);
  persistSession(id);
  return getAutoCalibrateStatus(undefined, id);
}

/**
 * Robot START — do NOT wipe progress. Only open a session if none exists.
 * Manual Reset watch / POST reset still uses beginAutoCalibrateSession.
 */
export function ensureAutoCalibrateSession(
  reason = 'robot_start',
  clientId?: number | null
): AutoCalibrateStatus {
  const id = resolveDeskClientId(clientId);
  hydrateSession(id);
  ensureCoreRegimesOn(id);
  const st = bucket(id).state;
  if (st.started_at) {
    st.last_summary = `Watch continues · client ${id} · ${reason} · closes=${st.trades.length}`;
    persistSession(id);
    return getAutoCalibrateStatus(undefined, id);
  }
  return beginAutoCalibrateSession(reason, id);
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
      peak_mfe_abs: cal.peak_mfe_abs,
      peak_retention: cal.peak_retention,
      target_abs: cal.target_abs,
      safety_tp_rr: cal.safety_tp_rr,
      entry_filter_level: cal.entry_filter_level,
      enabled_regimes: cal.enabled_regimes.length,
    },
  };
}

/**
 * Record one closed trade. Every AUTO_CALIBRATE_EVERY_N closes since START,
 * softly retunes desk calibration. Applied change starts entry cooldown.
 * Never throws. Open positions still managed during cooldown.
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
  const proposed = proposeAutoCalibration(current, window, state.demoted);
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

  if (!proposed.applied) {
    state.cycles_run += 1;
    state.last_cycle_at = at;
    state.last_summary = proposed.summary;
    state.last_changes = proposed.changes;
    pushHistory(false, 0);
    persistSession(id);
    return proposed;
  }

  const saved = setDeskCalibration(proposed.next, id);
  for (const ch of proposed.changes) {
    const m = /^regime OFF (.+)$/.exec(ch);
    if (m) state.demoted.add(m[1]!);
    const p = /^regime ON (.+)$/.exec(ch);
    if (p) state.demoted.delete(p[1]!);
  }
  state.cooldown_until_ms = Date.now() + AUTO_CALIBRATE_COOLDOWN_MS;
  state.cycles_run += 1;
  state.last_cycle_at = at;
  state.last_summary = `${proposed.summary} · COOLDOWN ${AUTO_CALIBRATE_COOLDOWN_MS / 60_000}m`;
  state.last_changes = proposed.changes;
  pushHistory(true, AUTO_CALIBRATE_COOLDOWN_MS / 1000);
  persistSession(id);
  return { ...proposed, next: saved };
}

/** Pure propose — unit-tested without disk. */
export function proposeAutoCalibration(
  current: DeskCalibration,
  windowTrades: SessionTrade[],
  demotedSession: Set<string> = new Set()
): AutoCalibrateProposeResult {
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
  const softLosses = windowTrades.filter((t) =>
    /HardInvalidation|HardInv/i.test(summarizeExitReason(t.exit_reason))
  ).length;
  const microWins = windowTrades.filter(
    (t) => t.pnl_pts > 1e-9 && t.pnl_pts < Math.max(1.0, avgLossAbs * 0.45)
  ).length;

  const next: DeskCalibration = {
    ...current,
    enabled_regimes: [...current.enabled_regimes],
  };

  // --- Soft Peak/Target + BROKER TP (safety_tp_rr). SL stays fixed. ---
  const needBiggerWinners =
    expectancy < 0.15 ||
    (avgWin > 0 && avgLossAbs > 0 && avgWin < avgLossAbs * 0.9) ||
    microWins >= 2;

  if (needBiggerWinners) {
    // Visible Capital SAFETY TP — raise R:R vs FIXED SL cushion
    const rrBefore = next.safety_tp_rr;
    next.safety_tp_rr = Math.min(3.5, (next.safety_tp_rr || 1.5) + 0.25);
    if (next.safety_tp_rr !== rrBefore) {
      changes.push(`safety_tp_rr ${rrBefore.toFixed(2)}→${next.safety_tp_rr.toFixed(2)}`);
    }

    const peakBefore = next.peak_mfe_abs;
    const retBefore = next.peak_retention;
    const tgtBefore = next.target_abs;
    next.peak_mfe_abs = Math.min(8.5, next.peak_mfe_abs + 0.5);
    next.peak_retention = Math.min(0.85, next.peak_retention + 0.04);
    next.peak_min_giveback_abs = Math.min(2.2, next.peak_min_giveback_abs + 0.15);
    next.target_abs = Math.min(20, next.target_abs + 1.25);
    next.target_pct = Math.min(0.015, next.target_pct * 1.12);
    next.peak_mfe_pct = Math.min(0.01, next.peak_mfe_pct * 1.08);
    if (next.peak_mfe_abs !== peakBefore) {
      changes.push(`peak_mfe_abs ${peakBefore.toFixed(1)}→${next.peak_mfe_abs.toFixed(1)}`);
    }
    if (next.peak_retention !== retBefore) {
      changes.push(`peak_retention ${retBefore.toFixed(2)}→${next.peak_retention.toFixed(2)}`);
    }
    if (next.target_abs !== tgtBefore) {
      changes.push(`target_abs ${tgtBefore.toFixed(1)}→${next.target_abs.toFixed(1)}`);
    }
  }

  // Soft HardInv / broker SL: intentionally NOT auto-tuned — SL stays as opened.

  // Already healthy — tiny retention polish only
  if (
    !needBiggerWinners &&
    expectancy >= 0.3 &&
    avgWin >= avgLossAbs * 0.95 &&
    wins.length >= losses.length
  ) {
    const retBefore = next.peak_retention;
    next.peak_retention = Math.min(0.82, next.peak_retention + 0.01);
    if (next.peak_retention !== retBefore) {
      changes.push(`peak_retention hold+ ${retBefore.toFixed(2)}→${next.peak_retention.toFixed(2)}`);
    }
  }

  // Ensure Peak stays above Soft CAP
  if (next.peak_mfe_abs <= next.hardinv_abs + 0.5) {
    next.peak_mfe_abs = next.hardinv_abs + 1.5;
    changes.push(`peak_mfe_abs floor vs Soft →${next.peak_mfe_abs.toFixed(1)}`);
  }
  if (next.target_abs <= next.hardinv_abs + 1) {
    next.target_abs = next.hardinv_abs + 3;
    changes.push(`target_abs floor vs Soft →${next.target_abs.toFixed(1)}`);
  }

  // --- Entry filter ladder (0 OPEN → 3 STRICT) — from market outcomes ---
  const levelBefore = Math.max(0, Math.min(3, Math.round(Number(next.entry_filter_level) || 0)));
  const needTighterEntries =
    expectancy < 0 ||
    softLosses >= 2 ||
    (losses.length >= 3 && wins.length <= 1) ||
    (microWins >= 2 && expectancy < 0.1);

  if (needTighterEntries && levelBefore < 3) {
    next.entry_filter_level = levelBefore + 1;
    changes.push(`entry_filter_level ${levelBefore}→${next.entry_filter_level}`);
  } else if (
    !needTighterEntries &&
    expectancy >= 0.35 &&
    avgWin >= avgLossAbs * 1.0 &&
    wins.length >= losses.length + 1 &&
    levelBefore > 0
  ) {
    next.entry_filter_level = levelBefore - 1;
    changes.push(`entry_filter_level ${levelBefore}→${next.entry_filter_level}`);
  }

  // --- Soft regime book ---
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

  // Promote clear winners
  for (const [r, st] of byRegime) {
    if (st.n >= 1 && st.sum > 0.4 && !enabled.has(r)) {
      enabled.add(r);
      demotedSession.delete(r);
      changes.push(`regime ON ${r}`);
    }
  }

  // Demote at most ONE worst *satellite* offender (never CORE)
  let demotedThisCycle: string | null = null;
  const offenders = [...byRegime.entries()]
    .filter(
      ([r, st]) =>
        !isCoreAlwaysOnRegime(r) && st.n >= 2 && st.sum < -0.35
    )
    .sort((a, b) => a[1].sum - b[1].sum);
  if (offenders.length && enabled.size > MIN_ENABLED_REGIMES) {
    const worst = offenders[0]![0];
    if (enabled.has(worst) && enabled.size - 1 >= MIN_ENABLED_REGIMES) {
      enabled.delete(worst);
      demotedSession.add(worst);
      demotedThisCycle = worst;
      changes.push(`regime OFF ${worst}`);
    }
  }

  // Positive cycle OR flat — soft re-promote one previously demoted regime
  if ((expectancy > 0.1 || !demotedThisCycle) && demotedSession.size) {
    const candidate = [...demotedSession].find((r) => r !== demotedThisCycle);
    if (candidate && !enabled.has(candidate)) {
      enabled.add(candidate);
      demotedSession.delete(candidate);
      changes.push(`regime ON ${candidate}`);
    }
  }

  // Core always stay ON — cannot starve liquid regimes
  for (const r of CORE_ALWAYS_ON_REGIMES) {
    if (!enabled.has(r)) {
      enabled.add(r);
      demotedSession.delete(r);
      changes.push(`regime ON ${r} (core)`);
    }
  }

  // Floor: never starve — refill from tradable defaults
  if (enabled.size < MIN_ENABLED_REGIMES) {
    for (const r of tradableDefaultRegimes()) {
      if (enabled.size >= MIN_ENABLED_REGIMES) break;
      if (!enabled.has(r)) {
        enabled.add(r);
        changes.push(`regime ON ${r} (floor)`);
      }
    }
  }

  next.enabled_regimes = [...enabled] as RegimeName[];

  // Every cycle must leave a visible footprint when window is not clearly healthy
  if (!changes.length && expectancy < 0.25) {
    const rrBefore = next.safety_tp_rr || 1.5;
    next.safety_tp_rr = Math.min(3.5, rrBefore + 0.15);
    if (next.safety_tp_rr !== rrBefore) {
      changes.push(`safety_tp_rr ${rrBefore.toFixed(2)}→${next.safety_tp_rr.toFixed(2)}`);
    }
    if ((next.entry_filter_level || 0) < 3 && expectancy < 0) {
      const lv = Math.round(Number(next.entry_filter_level) || 0);
      next.entry_filter_level = lv + 1;
      changes.push(`entry_filter_level ${lv}→${next.entry_filter_level}`);
    }
  }

  const summary =
    `n=${windowTrades.length} E=${expectancy.toFixed(2)} ` +
    `W/L=${wins.length}/${losses.length} avgW=${avgWin.toFixed(2)} avgL=${avgLossAbs.toFixed(2)}` +
    (changes.length ? ` · ${changes.length} tweaks` : ' · hold');

  return {
    applied: changes.length > 0,
    summary,
    changes,
    next,
  };
}

/** Test helper — wipe session state. */
export function _resetAutoCalibrateForTests(clientId: number = 0): void {
  const id = resolveDeskClientId(clientId);
  const b = bucket(id);
  b.enabled = true;
  b.hydrated = true; // skip disk during unit tests
  b.state = emptyState();
  try {
    const file = sessionPath(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
  // Also wipe sibling test clients commonly used
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
