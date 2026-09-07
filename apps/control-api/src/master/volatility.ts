/**
 * Relative volatility — Reader calculate_relative_volatility / evaluate_volatility_filter.
 * current TR / mean TR over lookback; > threshold → abnormal.
 */
import type { Bar } from './types.js';

function barTrueRange(bar: Bar, previousClose: number | null): number {
  const high = Number(bar.high);
  const low = Number(bar.low);
  if (![high, low].every((n) => Number.isFinite(n))) return 0;
  const range = high - low;
  if (previousClose == null || !Number.isFinite(previousClose)) return Math.max(0, range);
  return Math.max(range, Math.abs(high - previousClose), Math.abs(low - previousClose));
}

/** Current bar TR / mean TR in lookback window. 0 when empty/flat; Infinity if mean=0 but current>0. */
export function calculateRelativeVolatility(
  bars: Bar[] | null | undefined,
  lookbackBars = 14
): number {
  if (!bars?.length || lookbackBars <= 0) return 0;
  const window = bars.slice(-lookbackBars);
  const windowStart = bars.length - window.length;
  const trueRanges: number[] = [];
  for (let offset = 0; offset < window.length; offset++) {
    const barIndex = windowStart + offset;
    const prev = barIndex > 0 ? Number(bars[barIndex - 1]!.close) : null;
    trueRanges.push(barTrueRange(window[offset]!, prev));
  }
  const current = trueRanges[trueRanges.length - 1] ?? 0;
  const mean = trueRanges.reduce((s, n) => s + n, 0) / trueRanges.length;
  if (mean <= 0) return current <= 0 ? 0 : Number.POSITIVE_INFINITY;
  return current / mean;
}

export function relativeVolatilityAcceptable(
  relativeVolatility: number,
  threshold: number
): boolean {
  if (!(threshold > 0)) return true;
  return relativeVolatility <= threshold;
}
