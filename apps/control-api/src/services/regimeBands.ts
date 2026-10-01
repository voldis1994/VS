/**
 * Single coherent % ladder for 10s Gold regime + entry.
 * All consumers (classify / stabilize / entry / watch / isMoving) MUST use these.
 *
 * Strict body order (fraction of price):
 *   MOVE < TREND_STAY < TREND_ENTER < PULLBACK < REVERSAL
 *
 * Strict range order:
 *   COMPRESS_ABS < MOVE < MOVE_RANGE ≤ TREND_STAY < TREND_ENTER < EXPAND_ABS
 *
 * Gold ~2650 reference (points ≈ pct × 2650):
 *   MOVE        0.008% → 0.21 pt
 *   TREND_STAY  0.022% → 0.58 pt
 *   TREND_ENTER 0.038% → 1.01 pt
 *   PULLBACK    0.055% → 1.46 pt
 *   REVERSAL    0.160% → 4.24 pt
 *   COMPRESS    0.0055% → 0.15 pt
 *   EXPAND      0.060% → 1.59 pt
 *
 * Softened for real 10s scalps (Asia/quiet Gold): prior MOVE 0.012% / range 0.018%
 * starved overnight entries even when Capital 1m moved.
 */

/** Shared “real 10s move” floor — persist vote, isMoving body, entry dip/rally.
 *  Soft floor so quiet Gold 10s bars still arm — COMPRESS must stay strictly below. */
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

export const PERSIST_ENTER = 0.5;
export const PERSIST_STAY = 0.3;
export const PERSIST_PULLBACK = 0.2;

/** Entry dip/rally = ±MOVE (same floor as isMoving body) */
export const ENTRY_DIP = -MOVE;
export const ENTRY_RALLY = MOVE;

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
  if (!(TREND_ENTER - TREND_STAY >= 0.0001)) {
    throw new Error('stay→enter gap too thin (< 0.010%)');
  }
  if (!(PULLBACK - TREND_ENTER >= 0.0001)) {
    throw new Error('enter→pullback gap too thin (< 0.010%)');
  }
  if (Math.abs(ENTRY_DIP) !== MOVE || ENTRY_RALLY !== MOVE) {
    throw new Error('ENTRY_DIP/RALLY must equal ±MOVE');
  }
}

// Fail fast at module load in tests/runtime if someone breaks the ladder
assertRegimeBandsCoherent();
