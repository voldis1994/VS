/**
 * 10s Gold micro scalp — point-first thresholds.
 * HardInv must cut on tiny dumps — not wait for Safety SL (~3.5pt).
 */

/** HardInv cut in price points — Gold ~4660 → 1.2pt max pain on 10s. */
export const HARD_INV_GOLD_PT = 1.2;

/** Short-window thesis failure (~6×10s bars) — ~1.2pt / 4660. */
export const SHORT_THESIS_MOVE_PCT = 0.000258;

/** HardInv distance in price points for any instrument. */
export function hardInvalidationDistance(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  if (abs >= 1000) return HARD_INV_GOLD_PT;
  if (abs >= 100) return Math.max(abs * 0.0004, 0.2);
  return Math.max(abs * 0.0008, 0.08);
}
