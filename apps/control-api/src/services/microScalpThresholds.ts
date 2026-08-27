/**
 * Universal thresholds — ATR / tick metadata / relative pct.
 * No Gold-only branches (abs>=1000 → 2pt etc.).
 * Never invent magnitude floors (#56).
 */

import { instrumentFloor, magnitudeFloor, moveThresholdPts, type InstrumentMeta } from './volatilityNorm.js';

/** @deprecated name kept for imports — value is relative pct, not Gold points */
export const HARD_INV_GOLD_PT = 2.0;
/** @deprecated relative short-thesis pct (was 3pt @ ~4660) */
export const SHORT_THESIS_GOLD_PT = 3.0;
export const SHORT_THESIS_MOVE_PCT = 3.0 / 4660;
export const HARD_INV_MOVE_PCT = 0.00043;

/**
 * Capital Safety SL last-resort (~0.20%).
 * Wider than structural / HardInv — emergency only.
 */
export const SAFETY_SL_PCT = 0.002;

/** @deprecated legacy name — use bestOutcomeTarget */
export const PROFIT_TP_GOLD_PT = 2.0;

/** 5m hold horizon — bank green if stalled (was 3min micro-scalp). */
export const PROFIT_TIME_DECAY_MS = 15 * 60_000;

/**
 * HardInv distance — ATR + tick when known; else universal relative pct
 * (not an invented instrument floor).
 */
export function hardInvalidationDistance(
  entry: number,
  atr?: number | null,
  meta?: InstrumentMeta | null
): number {
  const pts = moveThresholdPts(entry, atr ?? null, 0.5, HARD_INV_MOVE_PCT, meta);
  if (pts != null) return pts;
  return Math.abs(entry) * HARD_INV_MOVE_PCT;
}

/** Short-window thesis failure threshold as pct of entry. */
export function shortThesisMovePct(
  entry: number,
  atr?: number | null,
  meta?: InstrumentMeta | null
): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return shortThesisPts(entry, atr, meta) / abs;
}

export function shortThesisPts(
  entry: number,
  atr?: number | null,
  meta?: InstrumentMeta | null
): number {
  const pts = moveThresholdPts(entry, atr ?? null, 0.75, SHORT_THESIS_MOVE_PCT, meta);
  if (pts != null) return pts;
  return Math.abs(entry) * SHORT_THESIS_MOVE_PCT;
}

export { magnitudeFloor, instrumentFloor };
