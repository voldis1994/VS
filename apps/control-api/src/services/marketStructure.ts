/**
 * 5m market structure on REAL candles.
 * Wick beyond level ≠ automatic breakout.
 */

import { adaptiveBufferPts, atrWilder, moveThresholdPts } from './volatilityNorm.js';
import { isRealBar, type DataProvenance } from './ohlcQuality.js';

export type StructureBar = {
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks?: number;
  provenance?: DataProvenance;
  /** Forming candle — must not confirm structure (#67) */
  forming?: boolean;
};

export type Pivot = {
  index: number;
  price: number;
  time_ms: number;
  kind: 'HIGH' | 'LOW';
};

export type SwingLabel = 'HH' | 'HL' | 'LH' | 'LL' | null;

export type StructureEventKind =
  | 'BOS'
  | 'CHOCH'
  | 'SWEEP'
  | 'RECLAIM'
  | 'BREAKOUT'
  | 'FAILED_BREAKOUT'
  | 'RETEST'
  | 'DISPLACEMENT';

export type StructureEvent = {
  kind: StructureEventKind;
  side: 'BULL' | 'BEAR';
  level: number;
  bar_index: number;
  detail: string;
};

export type MarketStructure = {
  pivots: Pivot[];
  last_swing_high: Pivot | null;
  last_swing_low: Pivot | null;
  swing_labels: { high: SwingLabel; low: SwingLabel };
  trend: 'UP' | 'DOWN' | 'RANGE';
  events: StructureEvent[];
  atr: number | null;
};

const PIVOT_LEFT = 2;
const PIVOT_RIGHT = 2;

/** Explicit REAL only — missing provenance is UNKNOWN (not REAL). */
function realOnly(bars: StructureBar[]): StructureBar[] {
  return bars.filter((b) => isRealBar(b) && !b.forming);
}

/** Classic fractal pivots — needs `right` closed bars after the candidate. */
export function findPivots(
  bars: StructureBar[],
  left = PIVOT_LEFT,
  right = PIVOT_RIGHT
): Pivot[] {
  const out: Pivot[] = [];
  const n = bars.length;
  for (let i = left; i < n - right; i++) {
    const b = bars[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      const o = bars[j]!;
      if (o.high >= b.high) isHigh = false;
      if (o.low <= b.low) isLow = false;
    }
    if (isHigh) {
      out.push({ index: i, price: b.high, time_ms: b.open_time_ms, kind: 'HIGH' });
    }
    if (isLow) {
      out.push({ index: i, price: b.low, time_ms: b.open_time_ms, kind: 'LOW' });
    }
  }
  return out;
}

export function labelSwings(pivots: Pivot[]): {
  high: SwingLabel;
  low: SwingLabel;
  lastHigh: Pivot | null;
  lastLow: Pivot | null;
  prevHigh: Pivot | null;
  prevLow: Pivot | null;
} {
  const highs = pivots.filter((p) => p.kind === 'HIGH');
  const lows = pivots.filter((p) => p.kind === 'LOW');
  const lastHigh = highs[highs.length - 1] ?? null;
  const prevHigh = highs[highs.length - 2] ?? null;
  const lastLow = lows[lows.length - 1] ?? null;
  const prevLow = lows[lows.length - 2] ?? null;

  let high: SwingLabel = null;
  let low: SwingLabel = null;
  if (lastHigh && prevHigh) {
    high = lastHigh.price > prevHigh.price ? 'HH' : 'LH';
  }
  if (lastLow && prevLow) {
    low = lastLow.price > prevLow.price ? 'HL' : 'LL';
  }
  return { high, low, lastHigh, lastLow, prevHigh, prevLow };
}

function trendFromSwings(high: SwingLabel, low: SwingLabel): 'UP' | 'DOWN' | 'RANGE' {
  if (high === 'HH' && low === 'HL') return 'UP';
  if (high === 'LH' && low === 'LL') return 'DOWN';
  return 'RANGE';
}

/**
 * Close beyond level = acceptance. Wick-only = sweep candidate, not breakout.
 */
export function closeBreaksLevel(
  bar: StructureBar,
  level: number,
  side: 'ABOVE' | 'BELOW'
): boolean {
  return side === 'ABOVE' ? bar.close > level : bar.close < level;
}

export function wickOnlyBeyond(
  bar: StructureBar,
  level: number,
  side: 'ABOVE' | 'BELOW'
): boolean {
  if (side === 'ABOVE') {
    return bar.high > level && bar.close <= level;
  }
  return bar.low < level && bar.close >= level;
}

export function detectDisplacement(
  bar: StructureBar,
  atr: number | null,
  price: number,
  meta?: { tick_size?: number | null; point_size?: number | null }
): boolean {
  const body = Math.abs(bar.close - bar.open);
  const thr = moveThresholdPts(price, atr, 0.6, 0.0008, meta);
  if (thr == null) return false; // UNKNOWN — do not invent displacement
  return body >= thr;
}

/**
 * Analyze REAL 5m (or any TF) bars for structure events on the last few candles.
 */
export function analyzeMarketStructure(
  rawBars: StructureBar[] | null | undefined,
  opts?: { pivotLeft?: number; pivotRight?: number }
): MarketStructure {
  const bars = realOnly(rawBars ?? []);
  const atr = atrWilder(bars, 14);
  const pivots = findPivots(bars, opts?.pivotLeft ?? PIVOT_LEFT, opts?.pivotRight ?? PIVOT_RIGHT);
  const swings = labelSwings(pivots);
  const trend = trendFromSwings(swings.high, swings.low);
  const events: StructureEvent[] = [];

  if (bars.length < 5) {
    return {
      pivots,
      last_swing_high: swings.lastHigh,
      last_swing_low: swings.lastLow,
      swing_labels: { high: swings.high, low: swings.low },
      trend,
      events,
      atr,
    };
  }

  const lastIdx = bars.length - 1;
  const last = bars[lastIdx]!;
  const price = last.close;
  const thr = moveThresholdPts(price, atr, 0.15, 0.0002);
  // UNKNOWN thr → never invent 0; breakout requires detectDisplacement (#3/#4)

  const sh = swings.lastHigh;
  const sl = swings.lastLow;

  // Sweep: wick beyond swing, close reclaims inside
  if (sh && wickOnlyBeyond(last, sh.price, 'ABOVE')) {
    events.push({
      kind: 'SWEEP',
      side: 'BEAR',
      level: sh.price,
      bar_index: lastIdx,
      detail: `SWEEP high ${sh.price.toFixed(5)} · wick-only (not breakout)`,
    });
    if (last.close < sh.price) {
      events.push({
        kind: 'RECLAIM',
        side: 'BEAR',
        level: sh.price,
        bar_index: lastIdx,
        detail: `RECLAIM below swept high ${sh.price.toFixed(5)}`,
      });
    }
  }
  if (sl && wickOnlyBeyond(last, sl.price, 'BELOW')) {
    events.push({
      kind: 'SWEEP',
      side: 'BULL',
      level: sl.price,
      bar_index: lastIdx,
      detail: `SWEEP low ${sl.price.toFixed(5)} · wick-only (not breakout)`,
    });
    if (last.close > sl.price) {
      events.push({
        kind: 'RECLAIM',
        side: 'BULL',
        level: sl.price,
        bar_index: lastIdx,
        detail: `RECLAIM above swept low ${sl.price.toFixed(5)}`,
      });
    }
  }

  // Breakout = close acceptance + displacement (no candle-color fallback)
  const bullLvl = sh ? (thr != null ? sh.price + thr * 0.05 : sh.price) : null;
  if (sh && bullLvl != null && closeBreaksLevel(last, bullLvl, 'ABOVE')) {
    if (detectDisplacement(last, atr, price)) {
      events.push({
        kind: 'BREAKOUT',
        side: 'BULL',
        level: sh.price,
        bar_index: lastIdx,
        detail: `BREAKOUT ↑ close accept ${sh.price.toFixed(5)}`,
      });
      if (trend === 'DOWN' || swings.high === 'LH') {
        events.push({
          kind: 'CHOCH',
          side: 'BULL',
          level: sh.price,
          bar_index: lastIdx,
          detail: `CHoCH bullish · broke last LH/high`,
        });
      } else {
        events.push({
          kind: 'BOS',
          side: 'BULL',
          level: sh.price,
          bar_index: lastIdx,
          detail: `BOS bullish · HH continuation`,
        });
      }
    }
  }

  const bearLvl = sl ? (thr != null ? sl.price - thr * 0.05 : sl.price) : null;
  if (sl && bearLvl != null && closeBreaksLevel(last, bearLvl, 'BELOW')) {
    if (detectDisplacement(last, atr, price)) {
      events.push({
        kind: 'BREAKOUT',
        side: 'BEAR',
        level: sl.price,
        bar_index: lastIdx,
        detail: `BREAKOUT ↓ close accept ${sl.price.toFixed(5)}`,
      });
      if (trend === 'UP' || swings.low === 'HL') {
        events.push({
          kind: 'CHOCH',
          side: 'BEAR',
          level: sl.price,
          bar_index: lastIdx,
          detail: `CHoCH bearish · broke last HL/low`,
        });
      } else {
        events.push({
          kind: 'BOS',
          side: 'BEAR',
          level: sl.price,
          bar_index: lastIdx,
          detail: `BOS bearish · LL continuation`,
        });
      }
    }
  }

  // Failed breakout: prior bar closed beyond, current closes back inside
  if (bars.length >= 2 && sh) {
    const prev = bars[lastIdx - 1]!;
    if (
      closeBreaksLevel(prev, sh.price, 'ABOVE') &&
      last.close < sh.price &&
      last.close < prev.close
    ) {
      events.push({
        kind: 'FAILED_BREAKOUT',
        side: 'BEAR',
        level: sh.price,
        bar_index: lastIdx,
        detail: `FAILED_BREAKOUT ↑ ${sh.price.toFixed(5)} · rejected`,
      });
    }
  }
  if (bars.length >= 2 && sl) {
    const prev = bars[lastIdx - 1]!;
    if (
      closeBreaksLevel(prev, sl.price, 'BELOW') &&
      last.close > sl.price &&
      last.close > prev.close
    ) {
      events.push({
        kind: 'FAILED_BREAKOUT',
        side: 'BULL',
        level: sl.price,
        bar_index: lastIdx,
        detail: `FAILED_BREAKOUT ↓ ${sl.price.toFixed(5)} · rejected`,
      });
    }
  }

  // Retest: broke previously, now touches level and holds
  if (bars.length >= 3 && sh && thr != null) {
    const hist = bars.slice(0, -1);
    const broke = hist.some((b) => closeBreaksLevel(b, sh.price, 'ABOVE'));
    if (
      broke &&
      last.low <= sh.price + thr &&
      last.low >= sh.price - thr * 2 &&
      last.close > sh.price &&
      last.close >= last.open
    ) {
      events.push({
        kind: 'RETEST',
        side: 'BULL',
        level: sh.price,
        bar_index: lastIdx,
        detail: `RETEST hold above ${sh.price.toFixed(5)}`,
      });
    }
  }
  if (bars.length >= 3 && sl && thr != null) {
    const hist = bars.slice(0, -1);
    const broke = hist.some((b) => closeBreaksLevel(b, sl.price, 'BELOW'));
    if (
      broke &&
      last.high >= sl.price - thr &&
      last.high <= sl.price + thr * 2 &&
      last.close < sl.price &&
      last.close <= last.open
    ) {
      events.push({
        kind: 'RETEST',
        side: 'BEAR',
        level: sl.price,
        bar_index: lastIdx,
        detail: `RETEST hold below ${sl.price.toFixed(5)}`,
      });
    }
  }

  if (detectDisplacement(last, atr, price)) {
    events.push({
      kind: 'DISPLACEMENT',
      side: last.close >= last.open ? 'BULL' : 'BEAR',
      level: last.close,
      bar_index: lastIdx,
      detail: `DISPLACEMENT body ${Math.abs(last.close - last.open).toFixed(5)}`,
    });
  }

  return {
    pivots,
    last_swing_high: swings.lastHigh,
    last_swing_low: swings.lastLow,
    swing_labels: { high: swings.high, low: swings.low },
    trend,
    events,
    atr,
  };
}

export function hasEvent(
  ms: MarketStructure,
  kind: StructureEventKind,
  side?: 'BULL' | 'BEAR'
): StructureEvent | null {
  return (
    ms.events.find((e) => e.kind === kind && (side == null || e.side === side)) ?? null
  );
}

/** Thesis-defining pivot for structural SL. */
export function thesisPivot(
  ms: MarketStructure,
  side: 'BUY' | 'SELL'
): Pivot | null {
  if (side === 'BUY') return ms.last_swing_low;
  return ms.last_swing_high;
}

export function structuralStopLevel(
  side: 'BUY' | 'SELL',
  pivot: Pivot | null,
  opts: {
    atr?: number | null;
    spread?: number | null;
    brokerMinStop?: number | null;
    price: number;
    tickSize?: number | null;
    pointSize?: number | null;
  }
): number | null {
  if (!pivot) return null;
  const buf = adaptiveBufferPts({
    price: opts.price,
    atr: opts.atr,
    spread: opts.spread,
    brokerMinStop: opts.brokerMinStop,
    tickSize: opts.tickSize,
    pointSize: opts.pointSize,
    atrMult: 0.2,
  });
  if (buf == null) return null; // UNKNOWN buffer — BLOCK structural SL invent
  return side === 'BUY' ? pivot.price - buf : pivot.price + buf;
}
