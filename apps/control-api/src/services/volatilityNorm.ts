/**
 * Universal volatility normalization — true Wilder ATR, tick/point metadata.
 * Critical UNKNOWN → null / caller blocks. Never invent Gold/Nasdaq floors.
 */

export type OhlcLike = {
  open: number;
  high: number;
  low: number;
  close: number;
};

export type InstrumentMeta = {
  tick_size?: number | null;
  point_size?: number | null;
};

/** True Wilder ATR: seed = SMA(TR, period), then RMA. Needs ≥ period+1 bars. */
export function atrWilder(bars: OhlcLike[], period = 14): number | null {
  if (!bars?.length || period < 1) return null;
  if (bars.length < period + 1) return null;

  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    if (!Number.isFinite(tr) || tr < 0) return null;
    trs.push(tr);
  }
  if (trs.length < period) return null;

  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i]!;
  atr /= period;

  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
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

/**
 * Instrument floor from metadata only.
 * UNKNOWN tick/point → null (do not invent magnitude floors).
 */
export function instrumentFloor(meta?: InstrumentMeta | null): number | null {
  if (!meta) return null;
  if (meta.tick_size != null && Number.isFinite(meta.tick_size) && meta.tick_size > 0) {
    return meta.tick_size;
  }
  if (meta.point_size != null && Number.isFinite(meta.point_size) && meta.point_size > 0) {
    return meta.point_size;
  }
  return null;
}

/** @deprecated Prefer instrumentFloor(meta). Kept for tests that migrate. */
export function magnitudeFloor(_price: number): number {
  return 0;
}

export function adaptiveBufferPts(opts: {
  price: number;
  atr?: number | null;
  spread?: number | null;
  brokerMinStop?: number | null;
  tickSize?: number | null;
  pointSize?: number | null;
  atrMult?: number;
}): number | null {
  const abs = Math.max(Math.abs(opts.price), 1e-9);
  const floor = instrumentFloor({
    tick_size: opts.tickSize,
    point_size: opts.pointSize,
  });
  const atrPart =
    opts.atr != null && opts.atr > 0 ? opts.atr * (opts.atrMult ?? 0.15) : null;
  const spr =
    opts.spread != null && opts.spread > 0 ? opts.spread * 1.5 : null;
  const broker =
    opts.brokerMinStop != null && opts.brokerMinStop > 0 ? opts.brokerMinStop * 0.25 : null;

  const parts = [atrPart, spr, broker, floor].filter(
    (x): x is number => x != null && Number.isFinite(x) && x > 0
  );
  if (!parts.length) return null; // UNKNOWN — caller must BLOCK
  return Math.max(...parts, abs * 1e-12);
}

export type VolContext = {
  atr: number | null;
  range: number | null;
  spread: number | null;
  price: number;
  tick_size: number | null;
};

export function buildVolContext(
  bars: OhlcLike[] | null | undefined,
  price: number,
  spread?: number | null,
  meta?: InstrumentMeta | null
): VolContext {
  const atr = bars?.length ? atrWilder(bars, 14) : null;
  const range = bars?.length ? rollingRangePts(bars, 20) : null;
  return {
    atr,
    range,
    spread: spread != null && spread > 0 ? spread : null,
    price,
    tick_size: instrumentFloor(meta),
  };
}

/**
 * Relative move threshold — ATR + optional tick floor (#56).
 * If both ATR and tick unknown → null (BLOCK — never invent).
 * pctFallback applies only together with a known tick/point floor.
 */
export function moveThresholdPts(
  price: number,
  atr: number | null | undefined,
  atrMult: number,
  pctFallback: number,
  meta?: InstrumentMeta | null
): number | null {
  const abs = Math.max(Math.abs(price), 1e-9);
  const floor = instrumentFloor(meta);
  if (atr != null && atr > 0) {
    return Math.max(atr * atrMult, floor ?? atr * 0.05);
  }
  if (floor != null && pctFallback > 0) {
    return Math.max(abs * pctFallback, floor);
  }
  return null;
}

/** Alias used by multi-TF readiness. */
export const computeAtrWilder = atrWilder;

/** ATR% of price for evidence — reachable, bounded. */
export function atrPctScore(atr: number | null, price: number): { score: number; detail: string } {
  if (atr == null || !(atr > 0) || !Number.isFinite(price) || price === 0) {
    return { score: 0, detail: 'ATR UNKNOWN' };
  }
  const pct = atr / Math.abs(price);
  // Healthy band ~0.02%–2%; too quiet or explosive → lower score
  if (pct < 0.00005) return { score: 0.25, detail: `ATR% ${(pct * 100).toFixed(4)} too quiet` };
  if (pct > 0.05) return { score: 0.35, detail: `ATR% ${(pct * 100).toFixed(3)} extreme` };
  if (pct > 0.02) return { score: 0.55, detail: `ATR% ${(pct * 100).toFixed(3)} elevated` };
  return { score: 0.85, detail: `ATR% ${(pct * 100).toFixed(4)}` };
}
