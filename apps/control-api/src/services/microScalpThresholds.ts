/**
 * 10s Gold micro scalp — point-first thresholds.
 */

/** HardInv cut in price points — Gold ~4660 → 2.0pt (user). */
export const HARD_INV_GOLD_PT = 2.0;

/** Short-window dump/rally thesis (~6–9×10s bars) — 4.0pt Gold (user). */
export const SHORT_THESIS_GOLD_PT = 4.0;
/** Pct form of short thesis at Gold ~4660 mid. */
export const SHORT_THESIS_MOVE_PCT = SHORT_THESIS_GOLD_PT / 4660;

/**
 * Capital Safety SL last-resort cushion (~0.08% ≈ 3.7pt Gold).
 * Wider than HardInv 2.0pt; must NOT be the old 0.20% (~9pt) hole.
 */
export const SAFETY_SL_PCT = 0.0008;

/** HardInv distance in price points for any instrument. */
export function hardInvalidationDistance(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  if (abs >= 1000) return HARD_INV_GOLD_PT;
  if (abs >= 100) return Math.max(abs * 0.0004, 0.2);
  return Math.max(abs * 0.0008, 0.08);
}
