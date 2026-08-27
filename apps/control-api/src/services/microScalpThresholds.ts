/**
 * Universal thresholds — ATR / pct of price.
 * No Gold-only branches (abs>=1000 → 2pt etc.).
 */

import { magnitudeFloor, moveThresholdPts } from './volatilityNorm.js';

/** @deprecated name kept for imports — value is relative pct, not Gold points */
export const HARD_INV_GOLD_PT = 2.0;
/** @deprecated relative short-thesis pct (was 3pt @ ~4660) */
export const SHORT_THESIS_GOLD_PT = 3.0;
export const SHORT_THESIS_MOVE_PCT = 3.0 / 4660;

/**
 * Capital Safety SL last-resort (~0.20%).
 * Wider than structural / HardInv — emergency only.
 */
export const SAFETY_SL_PCT = 0.002;

/** @deprecated legacy name — use bestOutcomeTarget */
export const PROFIT_TP_GOLD_PT = 2.0;

/** 5m hold horizon — bank green if stalled (was 3min micro-scalp). */
export const PROFIT_TIME_DECAY_MS = 15 * 60 * 1000;

/** HardInv distance — ATR-aware, universal instruments. */
export function hardInvalidationDistance(
  entry: number,
  atr?: number | null
): number {
  return moveThresholdPts(entry, atr ?? null, 0.5, 0.00043);
}

/** Short-window thesis failure threshold as pct of entry. */
export function shortThesisMovePct(entry: number, atr?: number | null): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  const pts = moveThresholdPts(entry, atr ?? null, 0.75, SHORT_THESIS_MOVE_PCT);
  return pts / abs;
}

export function shortThesisPts(entry: number, atr?: number | null): number {
  return moveThresholdPts(entry, atr ?? null, 0.75, SHORT_THESIS_MOVE_PCT);
}

export { magnitudeFloor };
