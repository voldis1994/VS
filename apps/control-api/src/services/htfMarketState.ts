/**
 * HTF Market State Engine — hierarchical higher-timeframe read for VS.
 *
 * Hierarchy (top-down, NOT majority vote):
 *   4H → 1H → 30m → 15m → 5m
 * 1m / 10s stay trigger/execution outside this engine.
 *
 * Pure functions only — never opens orders. Feeds TraderMind / entry pipeline.
 * Structure uses closed candles only (no forming-tip lookahead).
 */
import type { TfCandle, TfDir } from './multiTfRead.js';
import { lastClosedTfCandle } from './multiTfRead.js';

export type HtfTfFrame = '4H' | '1H' | '30m' | '15m' | '5m';

export type HtfStructureLabel = 'HH' | 'HL' | 'LH' | 'LL' | 'RANGE' | 'UNKNOWN';

export type HtfTrendMaturity =
  | 'EARLY'
  | 'MID'
  | 'LATE'
  | 'EXHAUSTED'
  | 'NONE';

export type HtfPhase =
  | 'IMPULSE'
  | 'PULLBACK'
  | 'TRANSITION'
  | 'COMPRESSION'
  | 'EXPANSION';

export type HtfVolatility = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

export type HtfBreakoutState = 'NONE' | 'ACCEPTANCE' | 'REJECTION';

export type HtfLiquidityEvent =
  | 'NONE'
  | 'SWEEP_HIGH'
  | 'SWEEP_LOW'
  | 'RECLAIM_HIGH'
  | 'RECLAIM_LOW';

export type HtfPriceLocation =
  | 'ABOVE_STRUCTURE'
  | 'BELOW_STRUCTURE'
  | 'AT_SWING_HIGH'
  | 'AT_SWING_LOW'
  | 'MID_RANGE'
  | 'PREMIUM'
  | 'DISCOUNT';

export type HtfPathStatus =
  | 'PENDING'
  | 'CONFIRMING'
  | 'CONFIRMED'
  | 'INVALIDATED'
  | 'EXPIRED';

export type HtfThesisSide = 'BUY' | 'SELL' | 'WAIT';

export type HtfSwingPoint = {
  price: number;
  /** Closed-candle index in the analysis window (no forming tip). */
  index: number;
  kind: 'H' | 'L';
};

export type HtfTfState = {
  tf: HtfTfFrame;
  structure: HtfStructureLabel;
  trend: TfDir;
  maturity: HtfTrendMaturity;
  phase: HtfPhase;
  swing_high: number | null;
  swing_low: number | null;
  last_swing_high: HtfSwingPoint | null;
  last_swing_low: HtfSwingPoint | null;
  liquidity: HtfLiquidityEvent;
  price_location: HtfPriceLocation;
  breakout: HtfBreakoutState;
  volatility: HtfVolatility;
  /** Closed-body direction of the last closed candle */
  dir: TfDir;
  confidence: number;
  /** Price location 0..1 inside swing high/low range */
  structure_pos: number | null;
};

export type HtfThesis = {
  side: HtfThesisSide;
  summary: string;
  structure: HtfStructureLabel;
  phase: HtfPhase;
  anchor_tf: HtfTfFrame;
};

export type HtfExpectedPath = {
  description: string;
  next_events: string[];
  /** Levels that confirm the primary thesis path (price must reach in thesis direction) */
  confirm_levels: number[];
  /** Levels that invalidate the primary thesis */
  invalidate_levels: number[];
};

export type HTFMarketState = {
  at_ms: number;
  /** Ordered 4H → 1H → 30m → 15m → 5m (missing frames omitted) */
  frames: HtfTfState[];
  primary_thesis: HtfThesis;
  alternative_thesis: HtfThesis;
  expected_path: HtfExpectedPath;
  invalidation: string;
  confidence: number;
  /**
   * Working bias from hierarchy (4H leads). FLAT when unclear/transition.
   * Never a simple 30/15/5 majority vote.
   */
  bias: TfDir;
  path_status: HtfPathStatus;
  summary: string;
  summary_lv: string;
};

/** Compact snapshot frozen on entry / closed trade for expectancy. */
export type HTFMarketStateCompact = {
  bias: TfDir | string;
  structure: HtfStructureLabel | string;
  phase: HtfPhase | string;
  maturity: HtfTrendMaturity | string;
  volatility: HtfVolatility | string;
  primary_side: HtfThesisSide | string;
  alt_side: HtfThesisSide | string;
  path_status: HtfPathStatus | string;
  confidence: number;
  anchor_tf: HtfTfFrame | string;
  liquidity: HtfLiquidityEvent | string;
  breakout: HtfBreakoutState | string;
  price_location: HtfPriceLocation | string;
  expected_path: string;
  invalidation: string;
};

export type HtfCandleBook = {
  tf4h?: TfCandle[] | null;
  tf1h?: TfCandle[] | null;
  tf30?: TfCandle[] | null;
  tf15?: TfCandle[] | null;
  tf5?: TfCandle[] | null;
  /** Optional live mid for path evaluation (not used for structure pivots). */
  live_price?: number | null;
  now_ms?: number;
};

const FRAME_ORDER: HtfTfFrame[] = ['4H', '1H', '30m', '15m', '5m'];

function candleDir(c: TfCandle | null | undefined): TfDir {
  if (!c || !Number.isFinite(c.open) || !Number.isFinite(c.close)) return 'FLAT';
  if (c.close > c.open) return 'UP';
  if (c.close < c.open) return 'DOWN';
  return 'FLAT';
}

/** Closed candles only — drop forming tip when ≥2 present (no lookahead). */
export function closedCandlesOnly(
  candles: TfCandle[] | null | undefined
): TfCandle[] {
  if (!candles?.length) return [];
  if (candles.length >= 2) return candles.slice(0, -1);
  return candles.slice();
}

type Pivot = HtfSwingPoint;

function pivots(candles: TfCandle[]): Pivot[] {
  const out: Pivot[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const a = candles[i - 1]!;
    const b = candles[i]!;
    const c = candles[i + 1]!;
    if (b.high >= a.high && b.high >= c.high) {
      out.push({ index: i, price: b.high, kind: 'H' });
    }
    if (b.low <= a.low && b.low <= c.low) {
      out.push({ index: i, price: b.low, kind: 'L' });
    }
  }
  return out;
}

export function structureFromSwings(
  highs: Pivot[],
  lows: Pivot[]
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
  if (hh && hl) return 'HH'; // bullish structure portrait (HH+HL) — label as HH family
  if (ll && lh) return 'LL'; // bearish (LL+LH)
  if (hh && !hl && !ll) return 'HH';
  if (hl && !hh && !lh) return 'HL';
  if (ll && !lh && !hh) return 'LL';
  if (lh && !ll && !hl) return 'LH';
  // Mixed swings → range unless one side clearly dominates
  if ((hh && ll) || (lh && hl)) return 'RANGE';
  return 'RANGE';
}

/** Map structure+net path → trend without majority TF voting. */
export function trendFromStructure(
  structure: HtfStructureLabel,
  net: number,
  mid: number
): TfDir {
  const thr = Math.max(Math.abs(mid) * 0.0004, 1e-9);
  if (structure === 'HH' || structure === 'HL') {
    if (net < -thr) return 'FLAT'; // structure bullish but path already failed
    return 'UP';
  }
  if (structure === 'LL' || structure === 'LH') {
    if (net > thr) return 'FLAT';
    return 'DOWN';
  }
  if (structure === 'RANGE' || structure === 'UNKNOWN') {
    if (net > thr * 2) return 'UP';
    if (net < -thr * 2) return 'DOWN';
    return 'FLAT';
  }
  return 'FLAT';
}

function avgRange(candles: TfCandle[]): number {
  if (!candles.length) return 0;
  let sum = 0;
  for (const c of candles) sum += Math.max(0, c.high - c.low);
  return sum / candles.length;
}

export function volatilityFromCandles(candles: TfCandle[]): HtfVolatility {
  if (candles.length < 4) return 'NORMAL';
  const recent = candles.slice(-4);
  const prior = candles.slice(-12, -4);
  const rAvg = avgRange(recent);
  const pAvg = avgRange(prior.length ? prior : candles.slice(0, -4));
  if (pAvg <= 1e-12) return rAvg > 0 ? 'HIGH' : 'LOW';
  const ratio = rAvg / pAvg;
  if (ratio < 0.55) return 'LOW';
  if (ratio < 1.25) return 'NORMAL';
  if (ratio < 2.0) return 'HIGH';
  return 'EXTREME';
}

export function phaseFromFrame(input: {
  structure: HtfStructureLabel;
  trend: TfDir;
  volatility: HtfVolatility;
  lastDir: TfDir;
  structurePos: number | null;
  breakout: HtfBreakoutState;
}): HtfPhase {
  const { structure, trend, volatility, lastDir, structurePos, breakout } = input;
  if (volatility === 'LOW' && (structure === 'RANGE' || structure === 'UNKNOWN')) {
    return 'COMPRESSION';
  }
  if (volatility === 'HIGH' || volatility === 'EXTREME') {
    if (breakout === 'ACCEPTANCE' || trend === lastDir) return 'EXPANSION';
  }
  if (trend === 'UP' && lastDir === 'DOWN') return 'PULLBACK';
  if (trend === 'DOWN' && lastDir === 'UP') return 'PULLBACK';
  if (trend === 'FLAT' && structure === 'RANGE') {
    return volatility === 'LOW' ? 'COMPRESSION' : 'TRANSITION';
  }
  if (breakout === 'REJECTION') return 'TRANSITION';
  if (trend !== 'FLAT' && lastDir === trend) {
    if (
      structurePos != null &&
      ((trend === 'UP' && structurePos >= 0.85) ||
        (trend === 'DOWN' && structurePos <= 0.15))
    ) {
      return 'EXPANSION';
    }
    return 'IMPULSE';
  }
  if (trend !== 'FLAT') return 'IMPULSE';
  return 'TRANSITION';
}

export function maturityFromFrame(input: {
  trend: TfDir;
  structure: HtfStructureLabel;
  structurePos: number | null;
  swingCount: number;
  phase: HtfPhase;
}): HtfTrendMaturity {
  const { trend, structurePos, swingCount, phase } = input;
  if (trend === 'FLAT') return 'NONE';
  if (phase === 'TRANSITION' || phase === 'COMPRESSION') return 'NONE';
  if (swingCount <= 2) return 'EARLY';
  if (
    structurePos != null &&
    ((trend === 'UP' && structurePos >= 0.9) ||
      (trend === 'DOWN' && structurePos <= 0.1))
  ) {
    return 'EXHAUSTED';
  }
  if (swingCount >= 5) return 'LATE';
  if (swingCount >= 3) return 'MID';
  return 'EARLY';
}

export function liquidityEvent(
  candles: TfCandle[],
  swingHigh: number | null,
  swingLow: number | null
): HtfLiquidityEvent {
  if (candles.length < 2) return 'NONE';
  const last = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;
  const eps = Math.max(Math.abs(last.close) * 1e-5, 1e-9);

  if (swingHigh != null && Number.isFinite(swingHigh)) {
    const swept =
      last.high > swingHigh + eps && last.close < swingHigh - eps;
    const reclaimed =
      prev.high > swingHigh + eps &&
      prev.close < swingHigh &&
      last.close > swingHigh + eps;
    if (reclaimed) return 'RECLAIM_HIGH';
    if (swept) return 'SWEEP_HIGH';
  }
  if (swingLow != null && Number.isFinite(swingLow)) {
    const swept =
      last.low < swingLow - eps && last.close > swingLow + eps;
    const reclaimed =
      prev.low < swingLow - eps &&
      prev.close > swingLow &&
      last.close < swingLow - eps;
    if (reclaimed) return 'RECLAIM_LOW';
    if (swept) return 'SWEEP_LOW';
  }
  return 'NONE';
}

export function breakoutState(
  candles: TfCandle[],
  swingHigh: number | null,
  swingLow: number | null
): HtfBreakoutState {
  if (candles.length < 2) return 'NONE';
  const last = candles[candles.length - 1]!;
  const eps = Math.max(Math.abs(last.close) * 1e-5, 1e-9);
  if (swingHigh != null) {
    if (last.close > swingHigh + eps) return 'ACCEPTANCE';
    if (last.high > swingHigh + eps && last.close <= swingHigh) return 'REJECTION';
  }
  if (swingLow != null) {
    if (last.close < swingLow - eps) return 'ACCEPTANCE';
    if (last.low < swingLow - eps && last.close >= swingLow) return 'REJECTION';
  }
  return 'NONE';
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

function analyzeTf(
  tf: HtfTfFrame,
  raw: TfCandle[] | null | undefined
): HtfTfState | null {
  const candles = closedCandlesOnly(raw);
  if (candles.length < 3) return null;

  const p = pivots(candles);
  const highs = p.filter((x) => x.kind === 'H');
  const lows = p.filter((x) => x.kind === 'L');
  const structure = structureFromSwings(highs.slice(-4), lows.slice(-4));
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const net = last.close - first.open;
  const mid = Math.abs(last.close) || 1;
  const trend = trendFromStructure(structure, net, mid);
  const lastSwingHigh = highs.length ? highs[highs.length - 1]! : null;
  const lastSwingLow = lows.length ? lows[lows.length - 1]! : null;
  // Use prior swing for sweep/breakout so the current extreme isn't self-referential
  const refHigh =
    highs.length >= 2 ? highs[highs.length - 2]!.price : lastSwingHigh?.price ?? null;
  const refLow =
    lows.length >= 2 ? lows[lows.length - 2]!.price : lastSwingLow?.price ?? null;
  const { location, pos } = priceLocationInStructure(last.close, refHigh, refLow);
  const vol = volatilityFromCandles(candles);
  const lastDir = candleDir(last);
  const brk = breakoutState(candles, refHigh, refLow);
  const phase = phaseFromFrame({
    structure,
    trend,
    volatility: vol,
    lastDir,
    structurePos: pos,
    breakout: brk,
  });
  const maturity = maturityFromFrame({
    trend,
    structure,
    structurePos: pos,
    swingCount: highs.length + lows.length,
    phase,
  });
  const liq = liquidityEvent(candles, refHigh, refLow);

  let confidence = 0.45;
  if (structure === 'HH' || structure === 'LL') confidence += 0.2;
  else if (structure === 'HL' || structure === 'LH') confidence += 0.12;
  if (phase === 'IMPULSE' || phase === 'EXPANSION') confidence += 0.1;
  if (phase === 'COMPRESSION' || phase === 'TRANSITION') confidence -= 0.05;
  if (maturity === 'EXHAUSTED') confidence -= 0.12;
  if (maturity === 'EARLY') confidence += 0.05;
  if (liq !== 'NONE') confidence += 0.05;
  if (brk === 'ACCEPTANCE') confidence += 0.08;
  if (brk === 'REJECTION') confidence -= 0.05;
  confidence = Math.max(0.15, Math.min(0.95, confidence));

  return {
    tf,
    structure,
    trend,
    maturity,
    phase,
    swing_high: refHigh,
    swing_low: refLow,
    last_swing_high: lastSwingHigh,
    last_swing_low: lastSwingLow,
    liquidity: liq,
    price_location: location,
    breakout: brk,
    volatility: vol,
    dir: lastDir,
    confidence,
    structure_pos: pos,
  };
}

/**
 * Hierarchical bias — higher TF leads. Lower TF may mark pullback/transition
 * but must not flip the working side by majority count.
 */
export function hierarchicalBias(frames: HtfTfState[]): {
  bias: TfDir;
  anchor: HtfTfState | null;
  phase: HtfPhase;
  confidence: number;
} {
  if (!frames.length) {
    return { bias: 'FLAT', anchor: null, phase: 'TRANSITION', confidence: 0 };
  }
  // Walk top-down for first clear trend
  let anchor: HtfTfState | null = null;
  for (const f of frames) {
    if (f.trend === 'UP' || f.trend === 'DOWN') {
      anchor = f;
      break;
    }
  }
  if (!anchor) {
    const lowest = frames[frames.length - 1]!;
    return {
      bias: 'FLAT',
      anchor: lowest,
      phase: lowest.phase,
      confidence: Math.min(...frames.map((f) => f.confidence)),
    };
  }

  let bias: TfDir = anchor.trend;
  let phase = anchor.phase;
  let confidence = anchor.confidence;

  // Lower frames refine phase; only invalidate bias on sustained opposite structure
  for (const f of frames) {
    if (f.tf === anchor.tf) continue;
    const rank = FRAME_ORDER.indexOf(f.tf);
    const anchorRank = FRAME_ORDER.indexOf(anchor.tf);
    if (rank <= anchorRank) continue;

    if (f.trend === bias) {
      if (f.phase === 'PULLBACK') phase = 'PULLBACK';
      else if (
        (f.phase === 'IMPULSE' || f.phase === 'EXPANSION') &&
        phase !== 'PULLBACK'
      ) {
        phase = f.phase;
        confidence = Math.min(0.95, confidence + 0.04);
      }
      continue;
    }
    if (f.trend === 'FLAT') {
      if (f.phase === 'COMPRESSION') phase = 'COMPRESSION';
      else if (phase !== 'PULLBACK') phase = 'TRANSITION';
      confidence = Math.max(0.2, confidence - 0.06);
      continue;
    }
    // Opposite trend on lower TF — default to pullback inside higher bias
    // (NOT a majority flip). Strong opposite structure on immediate child → FLAT.
    if (
      (f.structure === 'HH' || f.structure === 'LL') &&
      f.confidence >= 0.7 &&
      rank - anchorRank === 1 &&
      f.phase !== 'PULLBACK'
    ) {
      bias = 'FLAT';
      phase = 'TRANSITION';
      confidence = Math.max(0.2, Math.min(confidence, f.confidence) - 0.1);
      break;
    }
    phase = 'PULLBACK';
    confidence = Math.max(0.25, confidence - 0.08);
  }

  return { bias, anchor, phase, confidence };
}

function thesisFromHierarchy(
  bias: TfDir,
  phase: HtfPhase,
  anchor: HtfTfState | null,
  frames: HtfTfState[],
  kind: 'primary' | 'alt'
): HtfThesis {
  const a = anchor || frames[0]!;
  const structure = a?.structure || 'UNKNOWN';
  const anchorTf = a?.tf || '30m';

  if (kind === 'primary') {
    if (bias === 'UP') {
      return {
        side: 'BUY',
        summary:
          phase === 'PULLBACK'
            ? `${anchorTf} bullish structure · pullback — expect HL hold then continuation`
            : phase === 'COMPRESSION'
              ? `${anchorTf} bullish bias inside compression — wait expansion acceptance UP`
              : `${anchorTf} bullish (${structure}) · ${phase.toLowerCase()} — work as buyer`,
        structure,
        phase,
        anchor_tf: anchorTf,
      };
    }
    if (bias === 'DOWN') {
      return {
        side: 'SELL',
        summary:
          phase === 'PULLBACK'
            ? `${anchorTf} bearish structure · pullback — expect LH hold then continuation`
            : phase === 'COMPRESSION'
              ? `${anchorTf} bearish bias inside compression — wait expansion acceptance DOWN`
              : `${anchorTf} bearish (${structure}) · ${phase.toLowerCase()} — work as seller`,
        structure,
        phase,
        anchor_tf: anchorTf,
      };
    }
    return {
      side: 'WAIT',
      summary: `${anchorTf} unclear / transition (${structure}) — no HTF side`,
      structure,
      phase: phase || 'TRANSITION',
      anchor_tf: anchorTf,
    };
  }

  // Alternative thesis — fade / opposite / range mean-reversion
  if (bias === 'UP') {
    return {
      side: 'SELL',
      summary:
        a?.maturity === 'EXHAUSTED'
          ? `Alt: late ${anchorTf} rally exhaustion — fade only on rejection`
          : `Alt: failed HL / sweep-high rejection flips to SELL`,
      structure: structure === 'HH' || structure === 'HL' ? 'LH' : 'RANGE',
      phase: 'TRANSITION',
      anchor_tf: anchorTf,
    };
  }
  if (bias === 'DOWN') {
    return {
      side: 'BUY',
      summary:
        a?.maturity === 'EXHAUSTED'
          ? `Alt: late ${anchorTf} selloff exhaustion — fade only on rejection`
          : `Alt: failed LH / sweep-low reclaim flips to BUY`,
      structure: structure === 'LL' || structure === 'LH' ? 'HL' : 'RANGE',
      phase: 'TRANSITION',
      anchor_tf: anchorTf,
    };
  }
  const lowest = frames[frames.length - 1];
  if (lowest?.dir === 'UP') {
    return {
      side: 'BUY',
      summary: `Alt: range break acceptance UP on ${lowest.tf}`,
      structure: 'HH',
      phase: 'EXPANSION',
      anchor_tf: lowest.tf,
    };
  }
  if (lowest?.dir === 'DOWN') {
    return {
      side: 'SELL',
      summary: `Alt: range break acceptance DOWN on ${lowest.tf}`,
      structure: 'LL',
      phase: 'EXPANSION',
      anchor_tf: lowest.tf,
    };
  }
  return {
    side: 'WAIT',
    summary: 'Alt: stay flat until HTF structure clarifies',
    structure: 'RANGE',
    phase: 'COMPRESSION',
    anchor_tf: anchorTf,
  };
}

function buildExpectedPath(
  bias: TfDir,
  phase: HtfPhase,
  anchor: HtfTfState | null,
  frames: HtfTfState[]
): { path: HtfExpectedPath; invalidation: string } {
  const a = anchor || frames[0];
  const sh = a?.swing_high ?? null;
  const sl = a?.swing_low ?? null;
  const confirm: number[] = [];
  const invalidate: number[] = [];
  const events: string[] = [];
  let description: string;
  let invalidation: string;

  if (bias === 'UP') {
    if (phase === 'PULLBACK') {
      description = 'Pullback toward HL/discount, then impulse continuation UP';
      events.push('hold_hl', 'impulse_up', 'take_liquidity_above');
      if (sl != null) {
        confirm.push(sl);
        invalidate.push(sl);
      }
      if (sh != null) confirm.push(sh);
      invalidation = sl != null
        ? `Close below swing low ${sl.toFixed(2)} invalidates bullish HTF path`
        : 'Break of last HL / swing low invalidates bullish path';
    } else if (phase === 'COMPRESSION') {
      description = 'Compression then expansion — accept UP break of swing high';
      events.push('compress', 'break_high_accept', 'expansion_up');
      if (sh != null) confirm.push(sh);
      if (sl != null) invalidate.push(sl);
      invalidation = sl != null
        ? `Accepted break below ${sl.toFixed(2)} flips path bearish`
        : 'Accepted downside break invalidates bullish compression path';
    } else {
      description = 'Impulse/expansion UP — hold structure, seek higher liquidity';
      events.push('hold_structure', 'extension_up');
      if (sh != null) confirm.push(sh);
      if (sl != null) invalidate.push(sl);
      invalidation = sl != null
        ? `Close below ${sl.toFixed(2)} invalidates UP impulse path`
        : 'Loss of bullish structure invalidates path';
    }
  } else if (bias === 'DOWN') {
    if (phase === 'PULLBACK') {
      description = 'Pullback toward LH/premium, then impulse continuation DOWN';
      events.push('hold_lh', 'impulse_down', 'take_liquidity_below');
      if (sh != null) {
        confirm.push(sh);
        invalidate.push(sh);
      }
      if (sl != null) confirm.push(sl);
      invalidation = sh != null
        ? `Close above swing high ${sh.toFixed(2)} invalidates bearish HTF path`
        : 'Break of last LH / swing high invalidates bearish path';
    } else if (phase === 'COMPRESSION') {
      description = 'Compression then expansion — accept DOWN break of swing low';
      events.push('compress', 'break_low_accept', 'expansion_down');
      if (sl != null) confirm.push(sl);
      if (sh != null) invalidate.push(sh);
      invalidation = sh != null
        ? `Accepted break above ${sh.toFixed(2)} flips path bullish`
        : 'Accepted upside break invalidates bearish compression path';
    } else {
      description = 'Impulse/expansion DOWN — hold structure, seek lower liquidity';
      events.push('hold_structure', 'extension_down');
      if (sl != null) confirm.push(sl);
      if (sh != null) invalidate.push(sh);
      invalidation = sh != null
        ? `Close above ${sh.toFixed(2)} invalidates DOWN impulse path`
        : 'Loss of bearish structure invalidates path';
    }
  } else {
    description = 'No clear HTF path — wait for acceptance beyond range';
    events.push('wait_break_accept');
    if (sh != null) confirm.push(sh);
    if (sl != null) confirm.push(sl);
    invalidation = 'Path undefined until hierarchical bias forms';
  }

  return {
    path: {
      description,
      next_events: events,
      confirm_levels: confirm.filter((n) => Number.isFinite(n)),
      invalidate_levels: invalidate.filter((n) => Number.isFinite(n)),
    },
    invalidation,
  };
}

function frameArrow(d: TfDir): string {
  if (d === 'UP') return '↑';
  if (d === 'DOWN') return '↓';
  return '→';
}

/**
 * Build full HTFMarketState from Capital candle books.
 * Uses closed candles only for structure — no future bar peeking.
 */
export function buildHtfMarketState(book: HtfCandleBook): HTFMarketState {
  const frames: HtfTfState[] = [];
  const pairs: Array<[HtfTfFrame, TfCandle[] | null | undefined]> = [
    ['4H', book.tf4h],
    ['1H', book.tf1h],
    ['30m', book.tf30],
    ['15m', book.tf15],
    ['5m', book.tf5],
  ];
  for (const [tf, candles] of pairs) {
    const st = analyzeTf(tf, candles);
    if (st) frames.push(st);
  }

  const { bias, anchor, phase, confidence } = hierarchicalBias(frames);
  const primary = thesisFromHierarchy(bias, phase, anchor, frames, 'primary');
  const alternative = thesisFromHierarchy(bias, phase, anchor, frames, 'alt');
  const { path, invalidation } = buildExpectedPath(bias, phase, anchor, frames);

  // Optional live path peek (price only — does not rewrite structure)
  let path_status: HtfPathStatus = 'PENDING';
  if (
    book.live_price != null &&
    Number.isFinite(book.live_price) &&
    (path.confirm_levels.length || path.invalidate_levels.length)
  ) {
    path_status = evaluateHtfPathStatus({
      live_price: book.live_price,
      bias,
      expected_path: path,
      prior_status: 'PENDING',
    });
  }

  const stackLine = FRAME_ORDER.map((tf) => {
    const f = frames.find((x) => x.tf === tf);
    return f ? `${tf}${frameArrow(f.trend)}` : `${tf}?`;
  }).join(' ');

  const summary = `${stackLine} · bias ${bias} · ${phase} · ${primary.structure} · conf ${(confidence * 100).toFixed(0)}%`;
  const summary_lv =
    bias === 'UP'
      ? `HTF hierarhija ${stackLine} — primārā tēze BUY (${phase.toLowerCase()}), alt ${alternative.side}.`
      : bias === 'DOWN'
        ? `HTF hierarhija ${stackLine} — primārā tēze SELL (${phase.toLowerCase()}), alt ${alternative.side}.`
        : `HTF hierarhija ${stackLine} — nav skaidras puses, gaidu acceptance.`;

  return {
    at_ms: book.now_ms ?? Date.now(),
    frames,
    primary_thesis: primary,
    alternative_thesis: alternative,
    expected_path: path,
    invalidation,
    confidence,
    bias,
    path_status,
    summary,
    summary_lv,
  };
}

export function compactHtfMarketState(
  state: HTFMarketState | null | undefined
): HTFMarketStateCompact | null {
  if (!state) return null;
  const anchor = state.primary_thesis.anchor_tf;
  const frame =
    state.frames.find((f) => f.tf === anchor) || state.frames[0] || null;
  return {
    bias: state.bias,
    structure: state.primary_thesis.structure,
    phase: state.primary_thesis.phase,
    maturity: frame?.maturity ?? 'NONE',
    volatility: frame?.volatility ?? 'NORMAL',
    primary_side: state.primary_thesis.side,
    alt_side: state.alternative_thesis.side,
    path_status: state.path_status,
    confidence: state.confidence,
    anchor_tf: anchor,
    liquidity: frame?.liquidity ?? 'NONE',
    breakout: frame?.breakout ?? 'NONE',
    price_location: frame?.price_location ?? 'MID_RANGE',
    expected_path: state.expected_path.description,
    invalidation: state.invalidation,
  };
}

/**
 * Live path tracker — compare current price to frozen expected path levels.
 * Call on manage ticks; never mutates structure (read-only vs frozen entry path).
 */
export function evaluateHtfPathStatus(input: {
  live_price: number;
  bias: TfDir;
  expected_path: HtfExpectedPath;
  prior_status?: HtfPathStatus;
}): HtfPathStatus {
  const px = input.live_price;
  if (!Number.isFinite(px)) return input.prior_status || 'PENDING';
  const prior = input.prior_status || 'PENDING';
  if (prior === 'INVALIDATED' || prior === 'CONFIRMED' || prior === 'EXPIRED') {
    return prior;
  }

  for (const lvl of input.expected_path.invalidate_levels) {
    if (!Number.isFinite(lvl)) continue;
    if (input.bias === 'UP' && px < lvl) return 'INVALIDATED';
    if (input.bias === 'DOWN' && px > lvl) return 'INVALIDATED';
    if (input.bias === 'FLAT') {
      // flat path: both sides can invalidate once accepted beyond
      continue;
    }
  }

  let hitConfirm = false;
  for (const lvl of input.expected_path.confirm_levels) {
    if (!Number.isFinite(lvl)) continue;
    if (input.bias === 'UP' && px >= lvl) hitConfirm = true;
    if (input.bias === 'DOWN' && px <= lvl) hitConfirm = true;
  }
  if (hitConfirm) {
    // Prefer confirm beyond invalidate when both could fire — already checked invalidate
    return prior === 'CONFIRMING' ? 'CONFIRMED' : 'CONFIRMING';
  }
  return prior === 'CONFIRMING' ? 'CONFIRMING' : 'PENDING';
}

/**
 * Update live HTF path status from a frozen entry snapshot + live price/state.
 * HTF does not open/close orders — observation only for mind / ledger.
 */
export function trackHtfPathLive(input: {
  entry_htf: HTFMarketState;
  live_price: number | null | undefined;
  live_htf?: HTFMarketState | null;
}): HtfPathStatus {
  const entry = input.entry_htf;
  if (input.live_price == null || !Number.isFinite(input.live_price)) {
    return entry.path_status;
  }
  let status = evaluateHtfPathStatus({
    live_price: input.live_price,
    bias: entry.bias,
    expected_path: entry.expected_path,
    prior_status: entry.path_status,
  });
  // Live hierarchical flip vs frozen bias → invalidate
  if (
    input.live_htf &&
    entry.bias !== 'FLAT' &&
    input.live_htf.bias !== 'FLAT' &&
    input.live_htf.bias !== entry.bias &&
    input.live_htf.confidence >= 0.55
  ) {
    status = 'INVALIDATED';
  }
  return status;
}

/** Bucket key for conditional EV: structure|phase|setup|side */
export function htfExpectancyKey(input: {
  structure?: string | null;
  phase?: string | null;
  setup?: string | null;
  side?: string | null;
}): string {
  const s = String(input.structure || 'UNKNOWN').toUpperCase();
  const p = String(input.phase || 'UNKNOWN').toUpperCase();
  const setup = String(input.setup || 'NONE').toUpperCase();
  const side = String(input.side || 'NONE').toUpperCase();
  return `${s}|${p}|${setup}|${side}`;
}

/** Dir helpers for EffectiveRegimeHtf / capital dirs — from engine bias hierarchy. */
export function htfFrameDir(
  state: HTFMarketState | null | undefined,
  tf: HtfTfFrame
): TfDir | null {
  const f = state?.frames.find((x) => x.tf === tf);
  return f ? f.trend : null;
}

/** Tip/closed candle compatibility — last closed body dir only. */
export function closedBodyDir(candles: TfCandle[] | null | undefined): TfDir {
  return candleDir(lastClosedTfCandle(candles));
}
