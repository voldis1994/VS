/**
 * Single coherent % ladder for 10s Gold regime + entry.
 *
 * Factory constants below = BrainGenome defaults (prior hardcoded behaviour).
 * Live classify / stabilize / isMoving read getActiveRegimeBands() so Brain
 * Self Improve can evolve perception without changing regime algorithm meaning.
 *
 * Strict body order (fraction of price):
 *   MOVE < TREND_STAY < TREND_ENTER < PULLBACK < REVERSAL
 *
 * Strict range order:
 *   COMPRESS_ABS < MOVE < MOVE_RANGE ≤ TREND_STAY < TREND_ENTER < EXPAND_ABS
 */
import { getBrainGenome } from '../brainSelfImprove/brainGenome.js';

/** Shared “real 10s move” floor — factory default (genome.regime_move). */
export const MOVE = 0.00008;
/** Stay in an existing trend (must be > MOVE) */
export const TREND_STAY = 0.00022;
/** Enter a fresh trend (must be > TREND_STAY) */
export const TREND_ENTER = 0.00038;
/** Against-trend pullback body (must be > TREND_ENTER) */
export const PULLBACK = 0.00055;
/** Violent reversal body (must be > PULLBACK) */
export const REVERSAL = 0.0016;

/** isMoving range floor (≥ MOVE, ≤ TREND_STAY) — soft anti-starve for 10s entry */
export const MOVE_RANGE = 0.00012;
/** Compression absolute range (must be < MOVE) */
export const COMPRESS_ABS = 0.000055;
/** Expansion absolute range (must be > TREND_ENTER) */
export const EXPAND_ABS = 0.0006;

export const COMPRESS_AVG_MULT = 0.35;
export const EXPAND_AVG_MULT = 1.65;
export const NEAR_ZONE_MID = 0.28;
export const CLEAR_BREAK_FRAC = 0.25;
/** Positive RANGE — |persistence| ≤ this (not inRange default) */
export const RANGE_CHOP_PERSIST_MAX = 0.25;
/** Positive RANGE — |zoneTrek|/width ≤ this */
export const RANGE_CHOP_TREK_SHARE_MAX = 0.32;
/** Positive RANGE — trek efficiency ≤ this (high = directional leg) */
export const RANGE_CHOP_TREK_EFF_MAX = 0.45;

export const PERSIST_ENTER = 0.5;
export const PERSIST_STAY = 0.3;
export const PERSIST_PULLBACK = 0.2;

/** Entry dip/rally = ±MOVE (same floor as isMoving body) */
export const ENTRY_DIP = -MOVE;
export const ENTRY_RALLY = MOVE;

export type ActiveRegimeBands = {
  MOVE: number;
  TREND_STAY: number;
  TREND_ENTER: number;
  PULLBACK: number;
  REVERSAL: number;
  MOVE_RANGE: number;
  COMPRESS_ABS: number;
  EXPAND_ABS: number;
  COMPRESS_AVG_MULT: number;
  EXPAND_AVG_MULT: number;
  NEAR_ZONE_MID: number;
  CLEAR_BREAK_FRAC: number;
  RANGE_CHOP_PERSIST_MAX: number;
  RANGE_CHOP_TREK_SHARE_MAX: number;
  RANGE_CHOP_TREK_EFF_MAX: number;
  PERSIST_ENTER: number;
  PERSIST_STAY: number;
  PERSIST_PULLBACK: number;
  MIN_DWELL_BARS: number;
  CONFIRM_BARS: number;
  MOM_BARS: number;
  PERSIST_WINDOW: number;
  ENTRY_DIP: number;
  ENTRY_RALLY: number;
};

/** Live ladder from active BrainGenome (factory when genome missing fields). */
export function getActiveRegimeBands(): ActiveRegimeBands {
  const g = getBrainGenome();
  return {
    MOVE: g.regime_move,
    TREND_STAY: g.regime_trend_stay,
    TREND_ENTER: g.regime_trend_enter,
    PULLBACK: g.regime_pullback,
    REVERSAL: g.regime_reversal,
    MOVE_RANGE: g.regime_move_range,
    COMPRESS_ABS: g.regime_compress_abs,
    EXPAND_ABS: g.regime_expand_abs,
    COMPRESS_AVG_MULT: g.regime_compress_avg_mult,
    EXPAND_AVG_MULT: g.regime_expand_avg_mult,
    NEAR_ZONE_MID: g.regime_near_zone_mid,
    CLEAR_BREAK_FRAC: g.regime_clear_break_frac,
    RANGE_CHOP_PERSIST_MAX: g.regime_range_chop_persist_max,
    RANGE_CHOP_TREK_SHARE_MAX: g.regime_range_trek_share_max,
    RANGE_CHOP_TREK_EFF_MAX: g.regime_range_trek_eff_max,
    PERSIST_ENTER: g.regime_persist_enter,
    PERSIST_STAY: g.regime_persist_stay,
    PERSIST_PULLBACK: g.regime_persist_pullback,
    MIN_DWELL_BARS: g.regime_min_dwell_bars,
    CONFIRM_BARS: g.regime_confirm_bars,
    MOM_BARS: g.regime_mom_bars,
    PERSIST_WINDOW: g.regime_persist_window,
    ENTRY_DIP: -g.regime_move,
    ENTRY_RALLY: g.regime_move,
  };
}

const GOLD_REF = 2650;

/** Points at Gold reference — for docs/tests */
export function bandPts(frac: number, mid = GOLD_REF): number {
  return frac * mid;
}

/**
 * Runtime invariant: bands must form a strict ladder.
 * Throws if anyone edits constants into a contradictory set.
 */
export function assertRegimeBandsCoherent(): void {
  const body = [
    ['MOVE', MOVE],
    ['TREND_STAY', TREND_STAY],
    ['TREND_ENTER', TREND_ENTER],
    ['PULLBACK', PULLBACK],
    ['REVERSAL', REVERSAL],
  ] as const;
  for (let i = 1; i < body.length; i++) {
    const [aName, a] = body[i - 1]!;
    const [bName, b] = body[i]!;
    if (!(a < b)) {
      throw new Error(`regimeBands body order broken: ${aName}=${a} >= ${bName}=${b}`);
    }
  }
  if (!(COMPRESS_ABS < MOVE)) {
    throw new Error(`COMPRESS_ABS ${COMPRESS_ABS} must be < MOVE ${MOVE}`);
  }
  if (!(MOVE <= MOVE_RANGE && MOVE_RANGE <= TREND_STAY)) {
    throw new Error(`MOVE_RANGE ${MOVE_RANGE} must sit in [MOVE, TREND_STAY]`);
  }
  if (!(EXPAND_ABS > TREND_ENTER)) {
    throw new Error(`EXPAND_ABS ${EXPAND_ABS} must be > TREND_ENTER ${TREND_ENTER}`);
  }
  if (!(EXPAND_ABS - COMPRESS_ABS >= 0.00035)) {
    throw new Error('compress→expand dead zone too thin (< 0.035%)');
  }
  if (!(TREND_STAY - MOVE >= 0.0001)) {
    throw new Error('move→stay gap too thin (< 0.010%)');
  }
  if (!(TREND_ENTER - TREND_STAY >= 0.0001)) {
    throw new Error('stay→enter gap too thin (< 0.010%)');
  }
  if (!(PULLBACK - TREND_ENTER >= 0.0001)) {
    throw new Error('enter→pullback gap too thin (< 0.010%)');
  }
  if (!(REVERSAL - PULLBACK >= 0.0005)) {
    throw new Error('pullback→reversal gap too thin (< 0.050%)');
  }
  if (Math.abs(ENTRY_DIP) !== MOVE || ENTRY_RALLY !== MOVE) {
    throw new Error('ENTRY_DIP/RALLY must equal ±MOVE');
  }
}

/**
 * Live genome ladder — same atstarpes as factory. Brain mutations are repaired
 * in sanitizeGenome; this catches regressions if someone bypasses sanitize.
 */
export function assertActiveRegimeBandsCoherent(): void {
  const b = getActiveRegimeBands();
  if (!(b.COMPRESS_ABS < b.MOVE)) {
    throw new Error(`live COMPRESS_ABS ${b.COMPRESS_ABS} must be < MOVE ${b.MOVE}`);
  }
  if (!(b.TREND_STAY - b.MOVE >= 0.0001 - 1e-12)) {
    throw new Error('live move→stay gap too thin');
  }
  if (!(b.TREND_ENTER - b.TREND_STAY >= 0.0001 - 1e-12)) {
    throw new Error('live stay→enter gap too thin');
  }
  if (!(b.PULLBACK - b.TREND_ENTER >= 0.0001 - 1e-12)) {
    throw new Error('live enter→pullback gap too thin');
  }
  if (!(b.REVERSAL - b.PULLBACK >= 0.0005 - 1e-12)) {
    throw new Error('live pullback→reversal gap too thin');
  }
  if (!(b.EXPAND_ABS > b.TREND_ENTER)) {
    throw new Error(`live EXPAND_ABS ${b.EXPAND_ABS} must be > TREND_ENTER`);
  }
  if (!(b.EXPAND_ABS - b.COMPRESS_ABS >= 0.00035)) {
    throw new Error('live compress→expand dead zone too thin');
  }
  if (!(b.MOVE <= b.MOVE_RANGE && b.MOVE_RANGE <= b.TREND_STAY)) {
    throw new Error('live MOVE_RANGE must sit in [MOVE, TREND_STAY]');
  }
  if (!(b.PERSIST_ENTER - b.PERSIST_STAY >= 0.05)) {
    throw new Error('live persist stay→enter gap too thin');
  }
}

// Fail fast at module load in tests/runtime if someone breaks the ladder
assertRegimeBandsCoherent();
assertActiveRegimeBandsCoherent();
