/**
 * Universal thresholds — ATR / tick metadata required for HardInv/thesis (#32).
 * Critical UNKNOWN = BLOCK (null). No price-percentage invent.
 */

import { instrumentFloor, magnitudeFloor, moveThresholdPts, type InstrumentMeta } from './volatilityNorm.js';

/** @deprecated legacy name */
export const HARD_INV_GOLD_PT = 2.0;
/** @deprecated */
export const SHORT_THESIS_GOLD_PT = 3.0;
export const SHORT_THESIS_MOVE_PCT = 3.0 / 4660;
export const HARD_INV_MOVE_PCT = 0.00043;

/** Capital Safety SL last-resort (~0.20%) — used with instrument metadata only. */
export const SAFETY_SL_PCT = 0.002;

/** @deprecated */
export const PROFIT_TP_GOLD_PT = 2.0;

export const PROFIT_TIME_DECAY_MS = 15 * 60_000;

/**
 * HardInv distance — ATR + tick required. UNKNOWN → null (#32).
 */
export function hardInvalidationDistance(
  entry: number,
  atr?: number | null,
  meta?: InstrumentMeta | null
): number | null {
  return moveThresholdPts(entry, atr ?? null, 0.5, HARD_INV_MOVE_PCT, meta);
}

export function shortThesisMovePct(
  entry: number,
  atr?: number | null,
  meta?: InstrumentMeta | null
): number | null {
  const abs = Math.max(Math.abs(entry), 1e-9);
  const pts = shortThesisPts(entry, atr, meta);
  return pts == null ? null : pts / abs;
}

export function shortThesisPts(
  entry: number,
  atr?: number | null,
  meta?: InstrumentMeta | null
): number | null {
  return moveThresholdPts(entry, atr ?? null, 0.75, SHORT_THESIS_MOVE_PCT, meta);
}

export { magnitudeFloor, instrumentFloor };
