/** Deterministic indicators — no broker calls, no random. */

export function sma(values: number[], period: number): number | null {
  if (period < 1 || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  if (period < 1 || values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = sma(values.slice(0, period), period);
  if (prev == null) return null;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number
): number | null {
  if (period < 1 || highs.length < period + 1 || lows.length !== highs.length || closes.length !== highs.length) {
    return null;
  }
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  return sma(trs, period);
}

export function rsi(closes: number[], period: number): number | null {
  if (period < 1 || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function slope(values: number[], period: number): number | null {
  if (period < 2 || values.length < period) return null;
  const slice = values.slice(-period);
  const n = slice.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += slice[i];
    sumXY += i * slice[i];
    sumXX += i * i;
  }
  const den = n * sumXX - sumX * sumX;
  if (den === 0) return null;
  return (n * sumXY - sumX * sumY) / den;
}

export function bollinger(
  values: number[],
  period: number,
  mult = 2
): { mid: number; upper: number; lower: number; width: number } | null {
  const mid = sma(values, period);
  if (mid == null) return null;
  const slice = values.slice(-period);
  const variance = slice.reduce((a, v) => a + (v - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  return { mid, upper, lower, width: upper - lower };
}

export function donchian(
  highs: number[],
  lows: number[],
  period: number
): { high: number; low: number; mid: number } | null {
  if (period < 1 || highs.length < period || lows.length < period) return null;
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  return { high: h, low: l, mid: (h + l) / 2 };
}

export function roc(values: number[], period: number): number | null {
  if (values.length <= period) return null;
  const cur = values[values.length - 1];
  const prev = values[values.length - 1 - period];
  if (prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

export function momentum(values: number[], period: number): number | null {
  if (values.length <= period) return null;
  return values[values.length - 1] - values[values.length - 1 - period];
}
