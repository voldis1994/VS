/**
 * 10s Gold micro scalp — point-first thresholds.
 * HardInv cuts dumps; not so tight that every noise exit bleeds (−£0.02 spam).
 */

/** HardInv cut in price points — Gold ~4660 → 1.2pt (loosened from 0.6 — user: too narrow). */
export const HARD_INV_GOLD_PT = 1.2;

/** Short-window thesis failure (~6×10s bars) — ~1.2pt / 4660. */
export const SHORT_THESIS_MOVE_PCT = 0.000258;

/**
 * Capital Safety SL last-resort cushion (~0.08% ≈ 3.7pt Gold).
 * Wider than HardInv; must NOT be the old 0.20% (~9pt) hole.
 */
export const SAFETY_SL_PCT = 0.0008;

/** HardInv distance in price points for any instrument. */
export function hardInvalidationDistance(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  if (abs >= 1000) return HARD_INV_GOLD_PT;
  if (abs >= 100) return Math.max(abs * 0.0004, 0.2);
  return Math.max(abs * 0.0008, 0.08);
}
