/**
 * 10s Gold micro scalp — point-first thresholds.
 * HardInv must cut on 1–3pt dumps, NOT wait for ~7pt (0.15%).
 * Safety SL ~0.20% (~9pt) stays broker last-resort only.
 */

/** HardInv cut in price points — Gold ~4660 → 2.5pt max pain on 10s. */
export const HARD_INV_GOLD_PT = 2.5;

/** Short-window thesis failure (~6×10s bars) — ~2.5pt / 4660. */
export const SHORT_THESIS_MOVE_PCT = 0.00054;

/** HardInv distance in price points for any instrument. */
export function hardInvalidationDistance(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  if (abs >= 1000) return HARD_INV_GOLD_PT;
  if (abs >= 100) return Math.max(abs * 0.0005, 0.25);
  return Math.max(abs * 0.001, 0.1);
}
