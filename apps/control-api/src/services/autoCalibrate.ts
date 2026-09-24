/**
 * Ultimate desk auto-calibrate — watches closes since robot START and
 * softly retunes Soft/Peak/Target + regime allowlist every N closes.
 *
 * Soft by design: never daily/% entry blocks, never empty allowlist,
 * never starve below MIN_ENABLED_REGIMES. Lot size untouched.
 */
import {
  getDeskCalibration,
  setDeskCalibration,
  tradableDefaultRegimes,
  type DeskCalibration,
} from './deskCalibration.js';
import { summarizeExitReason } from './tradeLedger.js';
import type { RegimeName } from './regimes.js';

export const AUTO_CALIBRATE_EVERY_N = 5;
/** Never drop below this many regimes — entries stay possible. */
export const MIN_ENABLED_REGIMES = 5;

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

export type AutoCalibrateStatus = {
  enabled: boolean;
  session_started_at: string | null;
  closes_in_session: number;
  closes_until_next: number;
  cycles_run: number;
  last_cycle_at: string | null;
  last_summary: string | null;
  last_changes: string[];
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
};

const state: SessionState = {
  started_at: null,
  trades: [],
  cycles_run: 0,
  last_cycle_at: null,
  last_summary: null,
  last_changes: [],
  demoted: new Set(),
};

let enabled = true;

export function setAutoCalibrateEnabled(on: boolean): void {
  enabled = Boolean(on);
}

export function isAutoCalibrateEnabled(): boolean {
  return enabled;
}

/** Call when operator STARTS an entry-capable robot — resets the watch window. */
export function beginAutoCalibrateSession(reason = 'robot_start'): AutoCalibrateStatus {
  state.started_at = new Date().toISOString();
  state.trades = [];
  state.cycles_run = 0;
  state.last_cycle_at = null;
  state.last_summary = `Session start · ${reason}`;
  state.last_changes = [];
  state.demoted.clear();
  return getAutoCalibrateStatus();
}

export function getAutoCalibrateStatus(): AutoCalibrateStatus {
  const n = state.trades.length;
  const mod = n % AUTO_CALIBRATE_EVERY_N;
  const until =
    n === 0 ? AUTO_CALIBRATE_EVERY_N : mod === 0 && n > 0 ? AUTO_CALIBRATE_EVERY_N : AUTO_CALIBRATE_EVERY_N - mod;
  return {
    enabled,
    session_started_at: state.started_at,
    closes_in_session: n,
    closes_until_next: state.started_at ? until : AUTO_CALIBRATE_EVERY_N,
    cycles_run: state.cycles_run,
    last_cycle_at: state.last_cycle_at,
    last_summary: state.last_summary,
    last_changes: [...state.last_changes],
  };
}

/**
 * Record one closed trade. Every AUTO_CALIBRATE_EVERY_N closes since START,
 * softly retunes desk calibration. Never throws / never blocks trading.
 */
export function noteClosedTradeForAutoCalibrate(trade: SessionTrade): AutoCalibrateProposeResult | null {
  if (!enabled) return null;
  if (!state.started_at) {
    // First close without explicit start — open a session so learning still works
    beginAutoCalibrateSession('first_close');
  }
  const pts = Number(trade.pnl_pts);
  if (!Number.isFinite(pts)) return null;

  state.trades.push({
    ...trade,
    pnl_pts: pts,
    at: trade.at || new Date().toISOString(),
  });

  if (state.trades.length % AUTO_CALIBRATE_EVERY_N !== 0) return null;

  const window = state.trades.slice(-AUTO_CALIBRATE_EVERY_N);
  const current = getDeskCalibration();
  const proposed = proposeAutoCalibration(current, window, state.demoted);
  if (!proposed.applied) {
    state.cycles_run += 1;
    state.last_cycle_at = new Date().toISOString();
    state.last_summary = proposed.summary;
    state.last_changes = proposed.changes;
    return proposed;
  }

  const saved = setDeskCalibration(proposed.next);
  // Track demotions for soft re-promote later
  for (const ch of proposed.changes) {
    const m = /^regime OFF (.+)$/.exec(ch);
    if (m) state.demoted.add(m[1]!);
    const p = /^regime ON (.+)$/.exec(ch);
    if (p) state.demoted.delete(p[1]!);
  }
  state.cycles_run += 1;
  state.last_cycle_at = new Date().toISOString();
  state.last_summary = proposed.summary;
  state.last_changes = proposed.changes;
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

  // --- Soft / Peak / Target nudges (small steps, clamped by setDeskCalibration) ---
  const needBiggerWinners =
    expectancy < 0.15 ||
    (avgWin > 0 && avgLossAbs > 0 && avgWin < avgLossAbs * 0.9) ||
    microWins >= 2;

  if (needBiggerWinners) {
    const peakBefore = next.peak_mfe_abs;
    const retBefore = next.peak_retention;
    const tgtBefore = next.target_abs;
    next.peak_mfe_abs = Math.min(8.5, next.peak_mfe_abs + 0.5);
    next.peak_retention = Math.min(0.85, next.peak_retention + 0.04);
    next.peak_min_giveback_abs = Math.min(2.2, next.peak_min_giveback_abs + 0.15);
    next.target_abs = Math.min(12, next.target_abs + 0.75);
    next.target_pct = Math.min(0.01, next.target_pct * 1.08);
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

  if (softLosses >= 2 && avgLossAbs >= 1.5) {
    const hiBefore = next.hardinv_abs;
    next.hardinv_abs = Math.max(1.6, next.hardinv_abs - 0.15);
    next.hardinv_pct = Math.max(0.0004, next.hardinv_pct * 0.92);
    if (next.hardinv_abs !== hiBefore) {
      changes.push(`hardinv_abs ${hiBefore.toFixed(1)}→${next.hardinv_abs.toFixed(1)}`);
    }
  }

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

  // Demote at most ONE worst offender per cycle (soft)
  let demotedThisCycle: string | null = null;
  const offenders = [...byRegime.entries()]
    .filter(([, st]) => st.n >= 2 && st.sum < -0.35)
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

  // Positive cycle — soft re-promote one previously demoted regime
  // (never the one we just turned OFF this cycle)
  if (expectancy > 0.2 && demotedSession.size) {
    const candidate = [...demotedSession].find((r) => r !== demotedThisCycle);
    if (candidate && !enabled.has(candidate)) {
      enabled.add(candidate);
      demotedSession.delete(candidate);
      changes.push(`regime ON ${candidate}`);
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
export function _resetAutoCalibrateForTests(): void {
  enabled = true;
  state.started_at = null;
  state.trades = [];
  state.cycles_run = 0;
  state.last_cycle_at = null;
  state.last_summary = null;
  state.last_changes = [];
  state.demoted.clear();
}
