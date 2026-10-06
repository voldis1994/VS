/**
 * HTF FACTS — measurable structure from closed candles only.
 *
 * No trend/phase interpretation here. No orders. No lookahead (forming tip dropped).
 */
import type { TfCandle, TfDir } from './multiTfRead.js';

export type HtfTfFrame = '4H' | '1H' | '30m' | '15m' | '5m';

export type HtfTimedCandle = TfCandle & {
  /** Capital snapshot / bar open time — required for post-thesis event timing */
  open_time_ms?: number | null;
};

export type HtfStructureLabel = 'HH' | 'HL' | 'LH' | 'LL' | 'RANGE' | 'UNKNOWN';

export type HtfVolatility = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

export type HtfPriceLocation =
  | 'ABOVE_STRUCTURE'
  | 'BELOW_STRUCTURE'
  | 'AT_SWING_HIGH'
  | 'AT_SWING_LOW'
  | 'MID_RANGE'
  | 'PREMIUM'
  | 'DISCOUNT';

export type HtfSwingPoint = {
  price: number;
  index: number;
  kind: 'H' | 'L';
  /** Bar open time when known */
  open_time_ms: number | null;
};

export type HtfStructuralBreak = {
  side: 'UP' | 'DOWN';
  level: number;
  /** Index of closed candle that confirmed the break (close beyond) */
  confirm_index: number;
  open_time_ms: number | null;
};

export type HtfLiquidityPending = {
  kind: 'SWEEP_HIGH' | 'SWEEP_LOW';
  level: number;
  sweep_index: number;
  open_time_ms: number | null;
  /** Follow-up after sweep — not inferred as acceptance from the sweep candle alone */
  reaction: 'PENDING' | 'RECLAIMED' | 'CONTINUED' | 'EXPIRED';
};

export type HtfBreakoutEvent = {
  side: 'UP' | 'DOWN';
  level: number;
  /** Single close beyond = attempt; acceptance needs hold */
  status: 'ATTEMPT' | 'REJECTION' | 'ACCEPTANCE';
  attempt_index: number;
  resolve_index: number | null;
  open_time_ms: number | null;
};

export type HtfTfFacts = {
  tf: HtfTfFrame;
  candles: HtfTimedCandle[];
  swing_highs: HtfSwingPoint[];
  swing_lows: HtfSwingPoint[];
  last_swing_high: HtfSwingPoint | null;
  last_swing_low: HtfSwingPoint | null;
  /** Prior confirmed swing used as structure reference (not the tip extreme) */
  structure_high: number | null;
  structure_low: number | null;
  structure_label: HtfStructureLabel;
  structural_breaks: HtfStructuralBreak[];
  range_high: number | null;
  range_low: number | null;
  breakout: HtfBreakoutEvent | null;
  liquidity: HtfLiquidityPending | null;
  volatility: HtfVolatility;
  /** Pullback depth 0..1 vs last impulse leg (null if no clear impulse) */
  pullback_depth: number | null;
  price_location: HtfPriceLocation;
  structure_pos: number | null;
  /** Signed displacement of last closed bar vs ATR-like range */
  displacement: number;
  last_close: number;
  last_dir: TfDir;
  last_index: number;
  last_open_time_ms: number | null;
};

export type HtfFactsBundle = {
  at_ms: number;
  frames: HtfTfFacts[];
};

/** Target / minimum closed-candle history (excluding forming tip). */
export const HTF_HISTORY_TARGET: Record<HtfTfFrame, number> = {
  '4H': 80,
  '1H': 120,
  '30m': 100,
  '15m': 100,
  '5m': 100,
};

export const HTF_HISTORY_MIN: Record<HtfTfFrame, number> = {
  '4H': 40,
  '1H': 60,
  '30m': 50,
  '15m': 50,
  '5m': 50,
};

export const FRAME_ORDER: HtfTfFrame[] = ['4H', '1H', '30m', '15m', '5m'];

export function closedCandlesOnly(
  candles: HtfTimedCandle[] | null | undefined
): HtfTimedCandle[] {
  if (!candles?.length) return [];
  if (candles.length >= 2) return candles.slice(0, -1);
  return candles.slice();
}

export function candleDir(c: TfCandle | null | undefined): TfDir {
  if (!c || !Number.isFinite(c.open) || !Number.isFinite(c.close)) return 'FLAT';
  if (c.close > c.open) return 'UP';
  if (c.close < c.open) return 'DOWN';
  return 'FLAT';
}

function avgRange(candles: HtfTimedCandle[]): number {
  if (!candles.length) return 0;
  let sum = 0;
  for (const c of candles) sum += Math.max(0, c.high - c.low);
  return sum / candles.length;
}

export function volatilityFromCandles(candles: HtfTimedCandle[]): HtfVolatility {
  if (candles.length < 6) return 'NORMAL';
  const recent = candles.slice(-6);
  const prior = candles.slice(-24, -6);
  const rAvg = avgRange(recent);
  const pAvg = avgRange(prior.length ? prior : candles.slice(0, -6));
  if (pAvg <= 1e-12) return rAvg > 0 ? 'HIGH' : 'LOW';
  const ratio = rAvg / pAvg;
  if (ratio < 0.55) return 'LOW';
  if (ratio < 1.25) return 'NORMAL';
  if (ratio < 2.0) return 'HIGH';
  return 'EXTREME';
}

/** Confirmed pivots — left and right neighbor (closed only). */
export function confirmedPivots(candles: HtfTimedCandle[]): HtfSwingPoint[] {
  const out: HtfSwingPoint[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const a = candles[i - 1]!;
    const b = candles[i]!;
    const c = candles[i + 1]!;
    const t = b.open_time_ms ?? null;
    if (b.high >= a.high && b.high >= c.high) {
      out.push({ index: i, price: b.high, kind: 'H', open_time_ms: t });
    }
    if (b.low <= a.low && b.low <= c.low) {
      out.push({ index: i, price: b.low, kind: 'L', open_time_ms: t });
    }
  }
  return out;
}

export function structureFromSwings(
  highs: HtfSwingPoint[],
  lows: HtfSwingPoint[]
): HtfStructureLabel {
  if (highs.length < 2 || lows.length < 2) return 'UNKNOWN';
  const h1 = highs[highs.length - 1]!.price;
  const h0 = highs[highs.length - 2]!.price;
  const l1 = lows[lows.length - 1]!.price;
  const l0 = lows[lows.length - 2]!.price;
  const hh = h1 > h0;
  const lh = h1 < h0;
  const hl = l1 > l0;
  const ll = l1 < l0;
  if (hh && hl) return 'HH';
  if (ll && lh) return 'LL';
  if (hh && !hl && !ll) return 'HH';
  if (hl && !hh && !lh) return 'HL';
  if (ll && !lh && !hh) return 'LL';
  if (lh && !ll && !hl) return 'LH';
  if ((hh && ll) || (lh && hl)) return 'RANGE';
  return 'RANGE';
}

export function priceLocationInStructure(
  close: number,
  swingHigh: number | null,
  swingLow: number | null
): { location: HtfPriceLocation; pos: number | null } {
  if (
    swingHigh == null ||
    swingLow == null ||
    !Number.isFinite(swingHigh) ||
    !Number.isFinite(swingLow) ||
    swingHigh <= swingLow
  ) {
    return { location: 'MID_RANGE', pos: null };
  }
  const width = swingHigh - swingLow;
  const pos = Math.min(1, Math.max(0, (close - swingLow) / width));
  const near = Math.max(width * 0.05, Math.abs(close) * 1e-5);
  if (close > swingHigh + near) return { location: 'ABOVE_STRUCTURE', pos: 1 };
  if (close < swingLow - near) return { location: 'BELOW_STRUCTURE', pos: 0 };
  if (Math.abs(close - swingHigh) <= near) return { location: 'AT_SWING_HIGH', pos };
  if (Math.abs(close - swingLow) <= near) return { location: 'AT_SWING_LOW', pos };
  if (pos >= 0.65) return { location: 'PREMIUM', pos };
  if (pos <= 0.35) return { location: 'DISCOUNT', pos };
  return { location: 'MID_RANGE', pos };
}

/**
 * Displacement = last body / recent ATR. Large |d| = impulse candle fact.
 */
export function displacementOf(candles: HtfTimedCandle[]): number {
  if (candles.length < 2) return 0;
  const last = candles[candles.length - 1]!;
  const atr = avgRange(candles.slice(-14));
  if (atr <= 1e-12) return 0;
  return (last.close - last.open) / atr;
}

/**
 * Pullback depth vs last impulse leg (0 = at extreme, 1 = fully retraced).
 */
export function pullbackDepth(
  candles: HtfTimedCandle[],
  structure: HtfStructureLabel,
  structureHigh: number | null,
  structureLow: number | null
): number | null {
  if (candles.length < 4) return null;
  const last = candles[candles.length - 1]!;
  const bullish = structure === 'HH' || structure === 'HL';
  const bearish = structure === 'LL' || structure === 'LH';
  if (!bullish && !bearish) return null;
  if (bullish && structureHigh != null && structureLow != null) {
    const width = structureHigh - structureLow;
    if (width <= 1e-12) return null;
    // Depth from high toward low
    return Math.min(1, Math.max(0, (structureHigh - last.close) / width));
  }
  if (bearish && structureHigh != null && structureLow != null) {
    const width = structureHigh - structureLow;
    if (width <= 1e-12) return null;
    return Math.min(1, Math.max(0, (last.close - structureLow) / width));
  }
  return null;
}

function detectStructuralBreaks(
  candles: HtfTimedCandle[],
  highs: HtfSwingPoint[],
  lows: HtfSwingPoint[]
): HtfStructuralBreak[] {
  const out: HtfStructuralBreak[] = [];
  if (candles.length < 4) return out;
  // Walk forward: when close breaks a prior confirmed swing
  for (let i = 2; i < candles.length; i++) {
    const c = candles[i]!;
    const eps = Math.max(Math.abs(c.close) * 1e-5, 1e-9);
    const priorHighs = highs.filter((h) => h.index < i - 1);
    const priorLows = lows.filter((l) => l.index < i - 1);
    const sh = priorHighs.length ? priorHighs[priorHighs.length - 1]!.price : null;
    const sl = priorLows.length ? priorLows[priorLows.length - 1]!.price : null;
    if (sh != null && c.close > sh + eps) {
      const prev = candles[i - 1]!;
      if (prev.close <= sh + eps) {
        out.push({
          side: 'UP',
          level: sh,
          confirm_index: i,
          open_time_ms: c.open_time_ms ?? null,
        });
      }
    }
    if (sl != null && c.close < sl - eps) {
      const prev = candles[i - 1]!;
      if (prev.close >= sl - eps) {
        out.push({
          side: 'DOWN',
          level: sl,
          confirm_index: i,
          open_time_ms: c.open_time_ms ?? null,
        });
      }
    }
  }
  return out.slice(-6);
}

/**
 * Breakout facts: attempt / rejection / acceptance.
 * Acceptance requires TWO consecutive closes beyond the level (not one candle).
 */
export function detectBreakoutEvent(
  candles: HtfTimedCandle[],
  structureHigh: number | null,
  structureLow: number | null
): HtfBreakoutEvent | null {
  if (candles.length < 3) return null;
  const n = candles.length;
  const a = candles[n - 1]!;
  const b = candles[n - 2]!;
  const eps = Math.max(Math.abs(a.close) * 1e-5, 1e-9);

  if (structureHigh != null) {
    const aAbove = a.close > structureHigh + eps;
    const bAbove = b.close > structureHigh + eps;
    const aWick = a.high > structureHigh + eps && !aAbove;
    if (aAbove && bAbove) {
      return {
        side: 'UP',
        level: structureHigh,
        status: 'ACCEPTANCE',
        attempt_index: n - 2,
        resolve_index: n - 1,
        open_time_ms: a.open_time_ms ?? null,
      };
    }
    if (aWick || (b.high > structureHigh + eps && b.close <= structureHigh && !aAbove)) {
      return {
        side: 'UP',
        level: structureHigh,
        status: 'REJECTION',
        attempt_index: aWick ? n - 1 : n - 2,
        resolve_index: n - 1,
        open_time_ms: a.open_time_ms ?? null,
      };
    }
    if (aAbove && !bAbove) {
      return {
        side: 'UP',
        level: structureHigh,
        status: 'ATTEMPT',
        attempt_index: n - 1,
        resolve_index: null,
        open_time_ms: a.open_time_ms ?? null,
      };
    }
  }

  if (structureLow != null) {
    const aBelow = a.close < structureLow - eps;
    const bBelow = b.close < structureLow - eps;
    const aWick = a.low < structureLow - eps && !aBelow;
    if (aBelow && bBelow) {
      return {
        side: 'DOWN',
        level: structureLow,
        status: 'ACCEPTANCE',
        attempt_index: n - 2,
        resolve_index: n - 1,
        open_time_ms: a.open_time_ms ?? null,
      };
    }
    if (aWick || (b.low < structureLow - eps && b.close >= structureLow && !aBelow)) {
      return {
        side: 'DOWN',
        level: structureLow,
        status: 'REJECTION',
        attempt_index: aWick ? n - 1 : n - 2,
        resolve_index: n - 1,
        open_time_ms: a.open_time_ms ?? null,
      };
    }
    if (aBelow && !bBelow) {
      return {
        side: 'DOWN',
        level: structureLow,
        status: 'ATTEMPT',
        attempt_index: n - 1,
        resolve_index: null,
        open_time_ms: a.open_time_ms ?? null,
      };
    }
  }
  return null;
}

/**
 * Liquidity sweep as pending event + reaction tracking.
 * Sweep candle alone never equals acceptance.
 */
export function detectLiquidity(
  candles: HtfTimedCandle[],
  structureHigh: number | null,
  structureLow: number | null
): HtfLiquidityPending | null {
  if (candles.length < 3) return null;
  const epsBase = Math.abs(candles[candles.length - 1]!.close) * 1e-5;

  // Find most recent sweep in last 6 closed bars
  for (let i = candles.length - 1; i >= Math.max(1, candles.length - 6); i--) {
    const c = candles[i]!;
    const eps = Math.max(epsBase, 1e-9);
    if (structureHigh != null && c.high > structureHigh + eps && c.close < structureHigh - eps) {
      let reaction: HtfLiquidityPending['reaction'] = 'PENDING';
      // Follow-up candles after sweep
      for (let j = i + 1; j < candles.length; j++) {
        const n = candles[j]!;
        if (n.close > structureHigh + eps) {
          reaction = 'CONTINUED';
          break;
        }
        if (n.close < structureHigh - eps && n.high <= structureHigh + eps) {
          reaction = 'RECLAIMED';
          break;
        }
      }
      if (reaction === 'PENDING' && i < candles.length - 3) reaction = 'EXPIRED';
      return {
        kind: 'SWEEP_HIGH',
        level: structureHigh,
        sweep_index: i,
        open_time_ms: c.open_time_ms ?? null,
        reaction,
      };
    }
    if (structureLow != null && c.low < structureLow - eps && c.close > structureLow + eps) {
      let reaction: HtfLiquidityPending['reaction'] = 'PENDING';
      for (let j = i + 1; j < candles.length; j++) {
        const n = candles[j]!;
        if (n.close < structureLow - eps) {
          reaction = 'CONTINUED';
          break;
        }
        if (n.close > structureLow + eps && n.low >= structureLow - eps) {
          reaction = 'RECLAIMED';
          break;
        }
      }
      if (reaction === 'PENDING' && i < candles.length - 3) reaction = 'EXPIRED';
      return {
        kind: 'SWEEP_LOW',
        level: structureLow,
        sweep_index: i,
        open_time_ms: c.open_time_ms ?? null,
        reaction,
      };
    }
  }
  return null;
}

export function buildTfFacts(
  tf: HtfTfFrame,
  raw: HtfTimedCandle[] | null | undefined
): HtfTfFacts | null {
  const candles = closedCandlesOnly(raw);
  if (candles.length < 3) return null;

  const pivots = confirmedPivots(candles);
  const highs = pivots.filter((p) => p.kind === 'H');
  const lows = pivots.filter((p) => p.kind === 'L');
  const structure_label = structureFromSwings(highs.slice(-4), lows.slice(-4));
  const last_swing_high = highs.length ? highs[highs.length - 1]! : null;
  const last_swing_low = lows.length ? lows[lows.length - 1]! : null;
  // Structure ref = prior confirmed swing (avoid self-referential tip)
  const structure_high =
    highs.length >= 2 ? highs[highs.length - 2]!.price : last_swing_high?.price ?? null;
  const structure_low =
    lows.length >= 2 ? lows[lows.length - 2]!.price : last_swing_low?.price ?? null;

  const last = candles[candles.length - 1]!;
  const { location, pos } = priceLocationInStructure(
    last.close,
    structure_high,
    structure_low
  );
  const window = candles.slice(-Math.min(candles.length, 40));
  const range_high = Math.max(...window.map((c) => c.high));
  const range_low = Math.min(...window.map((c) => c.low));

  return {
    tf,
    candles,
    swing_highs: highs,
    swing_lows: lows,
    last_swing_high,
    last_swing_low,
    structure_high,
    structure_low,
    structure_label,
    structural_breaks: detectStructuralBreaks(candles, highs, lows),
    range_high,
    range_low,
    breakout: detectBreakoutEvent(candles, structure_high, structure_low),
    liquidity: detectLiquidity(candles, structure_high, structure_low),
    volatility: volatilityFromCandles(candles),
    pullback_depth: pullbackDepth(candles, structure_label, structure_high, structure_low),
    price_location: location,
    structure_pos: pos,
    displacement: displacementOf(candles),
    last_close: last.close,
    last_dir: candleDir(last),
    last_index: candles.length - 1,
    last_open_time_ms: last.open_time_ms ?? null,
  };
}

export type HtfCandleBook = {
  tf4h?: HtfTimedCandle[] | null;
  tf1h?: HtfTimedCandle[] | null;
  tf30?: HtfTimedCandle[] | null;
  tf15?: HtfTimedCandle[] | null;
  tf5?: HtfTimedCandle[] | null;
  live_price?: number | null;
  now_ms?: number;
};

export function buildHtfFacts(book: HtfCandleBook): HtfFactsBundle {
  const frames: HtfTfFacts[] = [];
  const pairs: Array<[HtfTfFrame, HtfTimedCandle[] | null | undefined]> = [
    ['4H', book.tf4h],
    ['1H', book.tf1h],
    ['30m', book.tf30],
    ['15m', book.tf15],
    ['5m', book.tf5],
  ];
  for (const [tf, candles] of pairs) {
    const f = buildTfFacts(tf, candles);
    if (f) frames.push(f);
  }
  return { at_ms: book.now_ms ?? Date.now(), frames };
}

export function factsFrame(
  bundle: HtfFactsBundle,
  tf: HtfTfFrame
): HtfTfFacts | null {
  return bundle.frames.find((f) => f.tf === tf) ?? null;
}
