/**
 * 10s Gold micro scalp — point-first thresholds.
 * HardInv must cut micro dumps before they wipe a stack of +£0.02…+£0.06 wins.
 */

/** HardInv cut in price points — Gold ~4660 → 0.6pt (~£0.05 @ 0.09). */
export const HARD_INV_GOLD_PT = 0.6;

/** Short-window thesis failure (~6×10s bars) — ~0.6pt / 4660. */
export const SHORT_THESIS_MOVE_PCT = 0.000129;

/**
 * Capital Safety SL last-resort cushion (~0.04% ≈ 1.9pt Gold).
 * Must stay wider than HardInv; must NOT be the old 0.20% (~9pt) hole.
 */
export const SAFETY_SL_PCT = 0.0004;

/** HardInv distance in price points for any instrument. */
export function hardInvalidationDistance(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  if (abs >= 1000) return HARD_INV_GOLD_PT;
  if (abs >= 100) return Math.max(abs * 0.0004, 0.2);
  return Math.max(abs * 0.0008, 0.08);
}
