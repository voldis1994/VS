/**
 * Universal volatility normalization — ATR / rolling range / spread.
 * No instrument-specific Gold point hardcodes.
 */

export type OhlcLike = {
  open: number;
  high: number;
  low: number;
  close: number;
};

export function atrWilder(bars: OhlcLike[], period = 14): number | null {
  if (!bars?.length || bars.length < 2) return null;
  const n = Math.min(period, bars.length - 1);
  if (n < 1) return null;
  const slice = bars.slice(-(n + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const cur = slice[i]!;
    const prev = slice[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    sum += tr;
  }
  const atr = sum / n;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

export function rollingRangePts(bars: OhlcLike[], lookback = 20): number | null {
  if (!bars?.length) return null;
  const w = bars.slice(-Math.max(lookback, 2));
  if (w.length < 2) return null;
  const high = Math.max(...w.map((b) => b.high));
  const low = Math.min(...w.map((b) => b.low));
  const r = high - low;
  return Number.isFinite(r) && r > 0 ? r : null;
}

/** Minimum price-floor by magnitude — not Gold-specific. */
export function magnitudeFloor(price: number): number {
  const abs = Math.max(Math.abs(price), 1e-9);
  if (abs >= 100) return 0.05;
  if (abs >= 10) return 0.01;
  if (abs >= 1) return 0.0001;
  return 0.00001;
}

export function adaptiveBufferPts(opts: {
  price: number;
  atr?: number | null;
  spread?: number | null;
  brokerMinStop?: number | null;
  atrMult?: number;
}): number {
  const abs = Math.max(Math.abs(opts.price), 1e-9);
  const atrPart =
    opts.atr != null && opts.atr > 0 ? opts.atr * (opts.atrMult ?? 0.15) : abs * 0.0001;
  const spr =
    opts.spread != null && opts.spread > 0 ? opts.spread * 1.5 : 0;
  const broker =
    opts.brokerMinStop != null && opts.brokerMinStop > 0 ? opts.brokerMinStop : 0;
  return Math.max(atrPart, spr, broker * 0.25, magnitudeFloor(abs) * 0.5);
}

export type VolContext = {
  atr: number | null;
  range: number | null;
  spread: number | null;
  price: number;
};

export function buildVolContext(
  bars: OhlcLike[] | null | undefined,
  price: number,
  spread?: number | null
): VolContext {
  const atr = bars?.length ? atrWilder(bars, 14) : null;
  const range = bars?.length ? rollingRangePts(bars, 20) : null;
  return {
    atr,
    range,
    spread: spread != null && spread > 0 ? spread : null,
    price,
  };
}

/** Relative move threshold from ATR or pct of price. */
export function moveThresholdPts(price: number, atr: number | null | undefined, atrMult: number, pctFallback: number): number {
  const abs = Math.max(Math.abs(price), 1e-9);
  if (atr != null && atr > 0) return Math.max(atr * atrMult, magnitudeFloor(abs));
  return Math.max(abs * pctFallback, magnitudeFloor(abs));
}
