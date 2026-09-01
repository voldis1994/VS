/**
 * MarketBrain — unified perception → regime → structure → action (Units 1–70).
 * Single source of truth for regime labels, entry gates, and dynamic exit params.
 */
import type { TenSecBar } from './tenSecondOhlc.js';
import {
  computeSignalEngine,
  SIGNAL_SCALES,
  type MacroRegime,
  type OperatingRegime,
  type SignalOutput,
  type SignalScale,
} from './signalEngine.js';
import type { TradePlaybook } from './playbooks.js';

export type MoveState =
  | 'EARLY'
  | 'DEVELOPING'
  | 'LATE'
  | 'EXTENDED'
  | 'EXHAUSTING'
  | 'UNKNOWN';

const L = 256;
const K_LAG = 4;
const EPS = 1e-10;

export type BrainMemory = {
  bar_count: number;
  /** Bar index when SIDE_CONFIRMED last fired */
  side_confirmed_at: number | null;
  side_high: number;
  side_low: number;
  inside_flags: number[];
  sideways_durations: number[];
  imp_raw_hist: number[];
  ds_raw_hist: number[];
  prev_side_confirmed: boolean;
  prev_ti: number;
  prev_imp: number;
  prev_mr: number;
  prev_side: number;
  ti_lag: number;
  ti_lag2: number;
  imp_lag: number;
};

export type BrainState = SignalOutput & {
  side_active: boolean;
  side_high: number;
  side_low: number;
  r_side: number;
  r_center: number;
  comp: number;
  comp_final: number;
  ce: number;
  side_quality: number;
  side_age: number;
  containment: number;
  break_valid: boolean;
  break_dir: -1 | 0 | 1;
  impulse: number;
  da: number;
  ds: number;
  ti_v: number;
  adjusted_target: number;
  break_price: number;
  expected_distance: number;
  move_now: number;
  used_potential: number;
  remaining_pct: number;
  exhaustion: number;
  survival: number;
  move_state: MoveState;
  dist_t1: number;
};

export type LockedBrainEntry = {
  break_price: number;
  break_dir: -1 | 0 | 1;
  r_side: number;
  expected_distance: number;
  adjusted_target: number;
  regime: OperatingRegime;
  macro: MacroRegime;
  side_high: number;
  side_low: number;
};

export type DynamicExitParams = {
  tpDistance: number | null;
  peakRet: number;
  harvestRet: number;
  timeDecayScale: number;
};

export function emptyBrainMemory(): BrainMemory {
  return {
    bar_count: 0,
    side_confirmed_at: null,
    side_high: 0,
    side_low: 0,
    inside_flags: [],
    sideways_durations: [],
    imp_raw_hist: [],
    ds_raw_hist: [],
    prev_side_confirmed: false,
    prev_ti: 0.5,
    prev_imp: 0.5,
    prev_mr: 0.5,
    prev_side: 0.5,
    ti_lag: 0.5,
    ti_lag2: 0.5,
    imp_lag: 0.5,
  };
}

function clip(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mad(xs: number[], med: number): number {
  if (!xs.length) return 0;
  return median(xs.map((x) => Math.abs(x - med)));
}

function robustZ(x: number, hist: number[]): number {
  const window = hist.slice(-L);
  if (window.length < 8) return 0;
  const med = median(window);
  const m = mad(window, med);
  return clip((x - med) / (1.4826 * m + EPS), -4, 4);
}

function rangeHighLow(closes: number[], n: number): number {
  if (!closes.length) return 0;
  const slice = closes.slice(-n);
  if (slice.length < 2) return 0;
  return Math.max(...slice) - Math.min(...slice);
}

function signDir(sum: number, fallback: number): -1 | 0 | 1 {
  if (sum >= 2) return 1;
  if (sum <= -2) return -1;
  if (fallback > 0.15) return 1;
  if (fallback < -0.15) return -1;
  return 0;
}

function moveStateFromUsed(used: number, exhaustion: number, survival: number): MoveState {
  if (exhaustion > survival) return 'EXHAUSTING';
  if (used >= 1) return 'EXTENDED';
  if (used >= 0.75) return 'LATE';
  if (used >= 0.4) return 'DEVELOPING';
  if (used > 0) return 'EARLY';
  return 'UNKNOWN';
}

function extendSignal(base: SignalOutput, extra: Omit<BrainState, keyof SignalOutput>): BrainState {
  return { ...base, ...extra };
}

export function updateMarketBrain(
  bars: TenSecBar[],
  previous: OperatingRegime = 'RANGE',
  memory: BrainMemory = emptyBrainMemory()
): { state: BrainState; memory: BrainMemory } {
  const core = computeSignalEngine(bars, previous);
  const mem: BrainMemory = { ...memory, bar_count: bars.length };
  const closes = bars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0);
  const price = closes[closes.length - 1] ?? 0;

  const emptyExtra = (over: Partial<BrainState> = {}): BrainState =>
    extendSignal(core, {
      side_active: false,
      side_high: price,
      side_low: price,
      r_side: 0,
      r_center: price,
      comp: 0,
      comp_final: 0,
      ce: 0,
      side_quality: 0,
      side_age: 0,
      containment: 0,
      break_valid: false,
      break_dir: 0,
      impulse: 0.5,
      da: 0,
      ds: 0.5,
      ti_v: 0,
      adjusted_target: price,
      break_price: price,
      expected_distance: 0,
      move_now: 0,
      used_potential: 0,
      remaining_pct: 100,
      exhaustion: 0.5,
      survival: 0.5,
      move_state: 'UNKNOWN',
      dist_t1: 0,
      ...over,
    });

  if (!core.ready || !closes.length) {
    return { state: emptyExtra(), memory: mem };
  }

  // Unit 30 — active sideways
  const side_active =
    core.p_sideways > core.p_trend && core.p_sideways > core.p_breakout && core.side_confirmed;

  // Track SIDE_CONFIRMED lifecycle
  if (core.side_confirmed && !mem.prev_side_confirmed) {
    mem.side_confirmed_at = bars.length;
    mem.side_high = price;
    mem.side_low = price;
    mem.inside_flags = [];
  }
  if (core.side_end && mem.side_confirmed_at != null) {
    const dur = bars.length - mem.side_confirmed_at;
    if (dur > 0) {
      mem.sideways_durations.push(dur);
      if (mem.sideways_durations.length > L) mem.sideways_durations.shift();
    }
    mem.side_confirmed_at = null;
    mem.inside_flags = [];
  }

  if (mem.side_confirmed_at != null && side_active) {
    mem.side_high = Math.max(mem.side_high, price);
    mem.side_low = Math.min(mem.side_low, price);
  }

  const side_high = mem.side_confirmed_at != null ? mem.side_high : price;
  const side_low = mem.side_confirmed_at != null ? mem.side_low : price;
  const r_side = Math.max(side_high - side_low, rangeHighLow(closes, 64), EPS);
  const r_center = (side_high + side_low) / 2;

  // Units 31–33 — multiscale range compression
  const r16 = rangeHighLow(closes, 16);
  const r32 = rangeHighLow(closes, 32);
  const r64 = rangeHighLow(closes, 64);
  const r128 = rangeHighLow(closes, 128);
  const rc1632 = r16 / (r32 + EPS);
  const rc3264 = r32 / (r64 + EPS);
  const rc64128 = r64 / (r128 + EPS);
  const rc = (rc1632 + rc3264 + rc64128) / 3;
  const comp = clip(1 - rc, 0, 1);
  const comp_agree =
    ((rc1632 < 0.85 ? 1 : 0) + (rc3264 < 0.85 ? 1 : 0) + (rc64128 < 0.85 ? 1 : 0)) / 3;
  const comp_final = comp * comp_agree;

  // Unit 34 — sideways age
  const side_age =
    mem.side_confirmed_at != null ? Math.max(0, bars.length - mem.side_confirmed_at) : 0;
  const age_scale = Math.max(1, median(mem.sideways_durations) || 12);
  const age_n = 1 - Math.exp(-side_age / age_scale);

  // Unit 35 — containment
  const inside =
    mem.side_confirmed_at != null && price <= side_high + EPS && price >= side_low - EPS ? 1 : 0;
  if (mem.side_confirmed_at != null) {
    mem.inside_flags.push(inside);
    if (mem.inside_flags.length > L) mem.inside_flags.shift();
  }
  const containWindow = mem.inside_flags.slice(-Math.min(side_age || 1, L));
  const containment = containWindow.length
    ? containWindow.reduce((a, b) => a + b, 0) / containWindow.length
    : 0;

  // Unit 36 — sideways quality
  const side_quality = clip((core.side + core.mr + comp_final + containment) / 4, 0, 1);

  // Unit 37 — compression energy
  const ce = Math.sqrt(Math.max(0, side_quality * age_n * comp_final * core.mr));

  // Units 38–41 — directional agreement / strength
  const dirs = SIGNAL_SCALES.map((n) => core.by_scale[n].DIR);
  const dir_sum = dirs.reduce((a, d) => a + Math.sign(d), 0);
  const break_dir = signDir(dir_sum, core.direction);
  const da = Math.abs(dir_sum) / 4;
  const ds_raw = dirs.reduce((a, d) => a + Math.abs(d), 0) / 4;
  mem.ds_raw_hist.push(ds_raw);
  if (mem.ds_raw_hist.length > L) mem.ds_raw_hist.shift();
  const ds = sigmoid(robustZ(ds_raw, mem.ds_raw_hist));

  // Units 42–44 — impulse
  const ti_v = core.ti - mem.ti_lag;
  const ti_a = ti_v - (mem.ti_lag - mem.ti_lag2);
  const ti_expansion = Math.max(0, ti_v) + Math.max(0, ti_a);
  const imp_raw = core.breakout * core.cp * core.ti * da * ds * (1 + ti_expansion);
  mem.imp_raw_hist.push(imp_raw);
  if (mem.imp_raw_hist.length > L) mem.imp_raw_hist.shift();
  const impulse = sigmoid(robustZ(imp_raw, mem.imp_raw_hist));

  // Units 45–46 — breakout validity
  const up_break = (price - side_high) / r_side;
  const down_break = (side_low - price) / r_side;
  const break_distance = Math.max(Math.max(up_break, down_break), 0);
  const break_valid =
    core.breakout > core.side && ti_v > 0 && da > 0.25 && break_distance > 0 && break_dir !== 0;

  const break_price = break_dir > 0 ? side_high : break_dir < 0 ? side_low : price;

  // Units 57–58 — exhaustion (before survival / targets)
  const imp_v = impulse - mem.imp_lag;
  const ti_decay = Math.max(0, mem.ti_lag - core.ti);
  const mr_growth = Math.max(0, core.mr - mem.prev_mr);
  const side_growth = Math.max(0, core.side - mem.prev_side);
  const exh_raw = mr_growth + side_growth + ti_decay + Math.max(0, -imp_v);
  const exhaustion = sigmoid(exh_raw);

  // Unit 64 — survival
  const survival = clip(core.ti * impulse * da * (1 - core.mr) * (1 - exhaustion), 0, 1);

  // Units 47–53, 67–68 — targets
  const dist_t1 = r_side;
  const active_mult = 1 + ce + impulse * da * survival + side_quality * ds * survival;
  const active_distance = r_side * active_mult;
  const expected_distance = r_side * Math.max(1, 1 + ce + impulse * da);

  const move_now = break_dir !== 0 ? Math.abs(price - break_price) : 0;
  const used_potential = clip(move_now / (expected_distance + EPS), 0, 1);
  const remaining_pct = 100 * (1 - used_potential);

  const move_state = moveStateFromUsed(used_potential, exhaustion, survival);

  const contraction = exhaustion * (1 - survival);
  const adjusted_distance =
    move_now +
    Math.max(0, active_distance - move_now) * (1 - contraction);
  const adjusted_target =
    break_dir > 0
      ? break_price + adjusted_distance
      : break_dir < 0
        ? break_price - adjusted_distance
        : price;

  // Update memory lags
  mem.prev_side_confirmed = core.side_confirmed;
  mem.ti_lag2 = mem.ti_lag;
  mem.ti_lag = core.ti;
  mem.imp_lag = impulse;
  mem.prev_ti = core.ti;
  mem.prev_imp = impulse;
  mem.prev_mr = core.mr;
  mem.prev_side = core.side;

  return {
    state: emptyExtra({
      side_active,
      side_high,
      side_low,
      r_side,
      r_center,
      comp,
      comp_final,
      ce,
      side_quality,
      side_age,
      containment,
      break_valid,
      break_dir,
      impulse,
      da,
      ds,
      ti_v,
      adjusted_target,
      break_price,
      expected_distance,
      move_now,
      used_potential,
      remaining_pct,
      exhaustion,
      survival,
      move_state,
      dist_t1,
    }),
    memory: mem,
  };
}

/** @deprecated use BrainState — kept for transitional imports */
export type SignalOutputCompat = BrainState;

export function lockBrainAtEntry(state: BrainState, entryPrice: number): LockedBrainEntry {
  const dir = state.break_dir !== 0 ? state.break_dir : state.direction >= 0 ? 1 : -1;
  const break_price =
    dir > 0 ? state.side_high : dir < 0 ? state.side_low : entryPrice;
  return {
    break_price,
    break_dir: dir as -1 | 0 | 1,
    r_side: state.r_side,
    expected_distance: state.expected_distance || state.dist_t1,
    adjusted_target: state.adjusted_target,
    regime: state.regime,
    macro: state.macro,
    side_high: state.side_high,
    side_low: state.side_low,
  };
}

export function brainEntryAllowed(
  state: BrainState,
  setupKind: string
): { ok: boolean; reason: string } {
  const k = String(setupKind || '').toUpperCase();
  if (!state.ready) return { ok: false, reason: 'brain seeding' };

  if (k === 'FADE' || k === 'FAILED_BREAK') {
    if (state.side_start || state.side_confirmed || state.side_active) {
      return { ok: true, reason: 'brain sideways lifecycle' };
    }
    if (state.p_sideways > 0.35) return { ok: true, reason: 'brain sideways pressure' };
    return { ok: false, reason: 'brain: no sideways signal' };
  }

  if (k === 'BREAKOUT' || k === 'CONTINUATION') {
    if (state.break_valid) return { ok: true, reason: 'brain breakout valid' };
    if (state.p_breakout > 0.35 && state.ti_v > 0) return { ok: true, reason: 'brain breakout pressure' };
    if (state.macro === 'TREND' && Math.abs(state.direction) > 0.2) {
      return { ok: true, reason: 'brain trend' };
    }
    return { ok: false, reason: 'brain: no breakout/trend' };
  }

  if (k === 'PULLBACK') {
    if (state.macro === 'TREND' || state.regime.includes('PULLBACK')) {
      return { ok: true, reason: 'brain pullback trend' };
    }
    return { ok: false, reason: 'brain: no trend for pullback' };
  }

  return { ok: true, reason: 'brain neutral' };
}

export function brainExitParams(
  state: BrainState,
  locked: LockedBrainEntry | null,
  mid: number,
  side: 'BUY' | 'SELL'
): DynamicExitParams {
  const ref = locked ?? lockBrainAtEntry(state, mid);
  const dir = side === 'BUY' ? 1 : -1;
  let tpDistance: number | null = null;

  if (ref.break_dir === dir && ref.adjusted_target > 0) {
    tpDistance = Math.abs(ref.adjusted_target - mid);
  } else if (ref.expected_distance > 0) {
    tpDistance = ref.expected_distance;
  } else if (state.dist_t1 > 0) {
    tpDistance = state.dist_t1;
  }

  const peakRet = clip(0.25 + 0.5 * state.survival, 0.2, 0.85);
  const harvestRet = clip(0.4 + 0.3 * (1 - state.exhaustion), 0.35, 0.9);
  const timeDecayScale =
    state.move_state === 'LATE' || state.move_state === 'EXTENDED'
      ? 0.65
      : state.move_state === 'EXHAUSTING'
        ? 0.4
        : 1;

  return { tpDistance, peakRet, harvestRet, timeDecayScale };
}

export function brainExitThesis(
  state: BrainState,
  side: 'BUY' | 'SELL',
  playbook: TradePlaybook
): string | null {
  if (state.move_state === 'EXHAUSTING' && state.exhaustion > state.survival) {
    return `BrainExhaustion · ${playbook} · ${state.move_state}`;
  }
  if (state.side_end && (playbook === 'FADE' || playbook === 'SCALP')) {
    return `BrainSideEnd · ${playbook} · breakout pressure`;
  }
  if (playbook === 'FADE' && state.break_valid && state.break_dir !== 0) {
    const against =
      (side === 'BUY' && state.break_dir < 0) || (side === 'SELL' && state.break_dir > 0);
    if (against) return `BrainBreakInvalid · FADE vs breakout dir ${state.break_dir}`;
  }
  if (state.used_potential >= 0.95 && state.exhaustion > 0.55) {
    return `BrainExtended · used ${(state.used_potential * 100).toFixed(0)}%`;
  }
  return null;
}

export { computeSignalEngine, SIGNAL_SCALES };
export type { MacroRegime, OperatingRegime, SignalOutput, SignalScale };
