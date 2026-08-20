/**
 * Multi-timeframe candle helpers for C++ calc snapshots.
 * Aggregates 1m Capital candles into 5m / 15m and counts bull/bear closes.
 */

export type OhlcBar = {
  open: number;
  high: number;
  low: number;
  close: number;
};

export type CandlePolarity = {
  n: number;
  bullish: number;
  bearish: number;
  doji: number;
};

/** Compact OHLC for pipeline / C++ (short keys keep calc-snapshot small). */
export type CompactBar = { o: number; h: number; l: number; c: number };

export function toCompactBar(b: OhlcBar): CompactBar {
  return { o: b.open, h: b.high, l: b.low, c: b.close };
}

/** Fold consecutive 1m bars into larger TF (oldest → newest). Drop incomplete bucket. */
export function aggregateMinutes(bars: OhlcBar[], size: number): OhlcBar[] {
  const n = Math.max(1, Math.floor(size));
  const clean = bars.filter(
    (b) =>
      b &&
      Number.isFinite(b.open) &&
      Number.isFinite(b.high) &&
      Number.isFinite(b.low) &&
      Number.isFinite(b.close)
  );
  if (clean.length < n) return [];
  const out: OhlcBar[] = [];
  const start = clean.length % n;
  for (let i = start; i + n <= clean.length; i += n) {
    const slice = clean.slice(i, i + n);
    const first = slice[0]!;
    let high = first.high;
    let low = first.low;
    for (const b of slice) {
      high = Math.max(high, b.high);
      low = Math.min(low, b.low);
    }
    out.push({
      open: first.open,
      high,
      low,
      close: slice[slice.length - 1]!.close,
    });
  }
  return out;
}

/** Last `lookback` closed candles: how many closed bullish vs bearish. */
export function countCandlePolarity(
  bars: Array<{ open: number; close: number }>,
  lookback = 200
): CandlePolarity {
  const w = bars
    .filter((b) => b && Number.isFinite(b.open) && Number.isFinite(b.close))
    .slice(-Math.max(1, lookback));
  let bullish = 0;
  let bearish = 0;
  let doji = 0;
  for (const b of w) {
    if (b.close > b.open) bullish += 1;
    else if (b.close < b.open) bearish += 1;
    else doji += 1;
  }
  return { n: w.length, bullish, bearish, doji };
}

/** Signed body pressure on a window: (+1 bull … −1 bear). */
export function barBodyPressure(bars: Array<{ open: number; close: number }>): number {
  const w = bars.filter((b) => b && Number.isFinite(b.open) && Number.isFinite(b.close));
  if (!w.length) return 0;
  let num = 0;
  for (const b of w) {
    const mid = Math.max(Math.abs(b.open), 1e-9);
    num += (b.close - b.open) / mid;
  }
  const raw = num / w.length;
  return Math.max(-1, Math.min(1, raw * 400));
}
