/**
 * Instrument-aware Capital Safety SL — single source of truth (#33/#34).
 * No price-magnitude floors. Uses tick/point/min-stop metadata.
 * Critical UNKNOWN → null (caller BLOCKS naked trade).
 */

import { SAFETY_SL_PCT } from './microScalpThresholds.js';
import { instrumentFloor, type InstrumentMeta } from './volatilityNorm.js';

export type SafetyStopInput = {
  direction: 'BUY' | 'SELL';
  mid: number;
  bid?: number | null;
  ask?: number | null;
  spread?: number | null;
  minStopDistance?: number | null;
  /** Capital min stop in points */
  minStopPoints?: number | null;
  pointSize?: number | null;
  tickSize?: number | null;
  loosen?: number;
};

export type SafetyStopResult = {
  ok: boolean;
  stop_level: number | null;
  stop_distance_pts: number | null;
  detail: string;
};

function roundToTick(raw: number, tick: number | null): number {
  if (tick != null && tick > 0) {
    return Math.round(raw / tick) * tick;
  }
  // No invented magnitude rounding — keep full precision when tick unknown
  return raw;
}

/**
 * Compute Safety SL level from instrument metadata.
 * Requires mid + (tick|point|minStop). Otherwise UNKNOWN → not ok.
 */
export function computeInstrumentSafetyStop(input: SafetyStopInput): SafetyStopResult {
  const mid = input.mid;
  if (!Number.isFinite(mid) || mid <= 0) {
    return { ok: false, stop_level: null, stop_distance_pts: null, detail: 'INVALID mid' };
  }

  const meta: InstrumentMeta = {
    tick_size: input.tickSize,
    point_size: input.pointSize,
  };
  const tick = instrumentFloor(meta);
  const pointSize =
    input.pointSize != null && input.pointSize > 0 ? input.pointSize : tick;

  const ref =
    input.direction === 'BUY'
      ? input.bid != null && Number.isFinite(input.bid)
        ? input.bid
        : mid
      : input.ask != null && Number.isFinite(input.ask)
        ? input.ask
        : mid;

  const spr =
    input.spread != null && Number.isFinite(input.spread) && input.spread > 0
      ? input.spread
      : input.bid != null && input.ask != null
        ? Math.max(input.ask - input.bid, 0)
        : null;

  const brokerMin =
    input.minStopDistance != null && input.minStopDistance > 0
      ? input.minStopDistance
      : null;

  const pctCushion = Math.abs(ref) * SAFETY_SL_PCT;
  const parts: number[] = [pctCushion];
  if (brokerMin != null) parts.push(brokerMin * 1.5);
  if (spr != null && spr > 0) parts.push(spr * 4);
  if (tick != null) parts.push(tick * 4);

  // Need at least pct + one instrument-aware term, or broker min
  if (brokerMin == null && tick == null && pointSize == null) {
    return {
      ok: false,
      stop_level: null,
      stop_distance_pts: null,
      detail: 'Safety SL UNKNOWN · missing tick/point/minStop metadata',
    };
  }

  const loosen = Math.max(input.loosen ?? 1, 1);
  const dist = Math.max(...parts) * loosen;
  const raw = input.direction === 'BUY' ? ref - dist : ref + dist;
  const stop_level = roundToTick(raw, tick);

  let stop_distance_pts: number | null = null;
  if (pointSize != null && pointSize > 0) {
    const minPts =
      input.minStopPoints != null && input.minStopPoints > 0 ? input.minStopPoints : dist / pointSize;
    stop_distance_pts = Math.max(minPts * 1.5, dist / pointSize, minPts);
  }

  return {
    ok: true,
    stop_level,
    stop_distance_pts,
    detail: `Safety SL · dist ${dist.toFixed(6)} · tick=${tick ?? 'n/a'}`,
  };
}

/** Alias used by Capital client / desk. */
export function computeSafetyCushionStopLevel(
  direction: 'BUY' | 'SELL',
  mid: number,
  bid: number | null,
  ask: number | null,
  opts?: {
    spread?: number | null;
    minStopDistance?: number | null;
    pointSize?: number | null;
    tickSize?: number | null;
    loosen?: number;
  }
): number | null {
  const r = computeInstrumentSafetyStop({
    direction,
    mid,
    bid,
    ask,
    spread: opts?.spread,
    minStopDistance: opts?.minStopDistance,
    pointSize: opts?.pointSize,
    tickSize: opts?.tickSize,
    loosen: opts?.loosen,
  });
  return r.ok ? r.stop_level : null;
}
