/**
 * Multi-dimensional market state — measurements, not fake FLAT/UNKNOWN regimes.
 * Label is UI-only interpretation derived from scores.
 */

import { atr, slope, sma, swingHighs, swingLows, trendStrength } from '../../indicators/src/index.js';
import type { Candle10s, MarketStateVector } from './types.js';
import { candlesAvailableAt } from './ohlc10s.js';

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function rSquared(values: number[]): number | null {
  if (values.length < 3) return null;
  const n = values.length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0,
    sumYY = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumXX += i * i;
    sumYY += values[i]! * values[i]!;
  }
  const den = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
  if (den === 0) return null;
  const r = (n * sumXY - sumX * sumY) / den;
  return r * r;
}

function structurePattern(closes: number[], highs: number[], lows: number[]): string | null {
  const sh = swingHighs(highs, 2);
  const sl = swingLows(lows, 2);
  if (sh.length < 2 || sl.length < 2) return null;
  const h1 = sh[sh.length - 2]!,
    h2 = sh[sh.length - 1]!;
  const l1 = sl[sl.length - 2]!,
    l2 = sl[sl.length - 1]!;
  const hh = h2 > h1;
  const hl = l2 > l1;
  const lh = h2 < h1;
  const ll = l2 < l1;
  if (hh && hl) return 'HH_HL';
  if (lh && ll) return 'LH_LL';
  if (hh && ll) return 'HH_LL';
  if (lh && hl) return 'LH_HL';
  return 'MIXED';
}

function interpretLabel(v: MarketStateVector): string | null {
  if (v.status !== 'OK') return null;
  const dir = v.direction_score ?? 0;
  const ts = v.trend_strength ?? 0;
  const tq = v.trend_quality ?? 0;
  const exp = v.expansion_score ?? 0;
  const comp = v.compression_score ?? 0;
  const br = v.breakout_score ?? 0;
  const rev = v.reversal_pressure ?? 0;
  if (br >= 0.65 && exp >= 0.5) return 'BREAKOUT';
  if (rev >= 0.7) return 'REVERSAL_TRANSITION';
  if (comp >= 0.7) return 'COMPRESSION';
  if (exp >= 0.7 && ts < 0.4) return 'VOLATILITY_EXPANSION';
  if (ts >= 0.55 && tq >= 0.4 && dir > 0.2) return 'TREND_UP';
  if (ts >= 0.55 && tq >= 0.4 && dir < -0.2) return 'TREND_DOWN';
  if (ts < 0.35 && comp >= 0.4) return 'RANGE_ROTATION';
  return null; // no label — measurements still valid
}

/**
 * Build market state from closed 10s candles available at asOf.
 * Returns INSUFFICIENT_DATA rather than inventing FLAT/UNKNOWN market regimes.
 */
export function buildMarketStateVector(input: {
  instrument: string;
  candles: Candle10s[];
  asOf: string;
  feedConfidence?: number | null;
  spreadQuality?: number | null;
  minBars?: number;
}): MarketStateVector {
  const minBars = input.minBars ?? 30;
  const avail = candlesAvailableAt(input.candles, input.asOf);
  const base: MarketStateVector = {
    instrument: input.instrument,
    as_of: input.asOf,
    direction_score: null,
    trend_strength: null,
    trend_quality: null,
    volatility_percentile: null,
    compression_score: null,
    expansion_score: null,
    momentum_score: null,
    structure_score: null,
    breakout_score: null,
    reversal_pressure: null,
    noise_score: null,
    liquidity_score: null,
    spread_quality: input.spreadQuality ?? null,
    feed_confidence: input.feedConfidence ?? null,
    label: null,
    inputs: {
      bar_count: avail.length,
      atr: null,
      slope: null,
      r_squared: null,
      hh_hl_lh_ll: null,
    },
    status: 'INSUFFICIENT_DATA',
  };

  if (avail.length === 0) {
    return { ...base, status: 'FEED_UNAVAILABLE' };
  }
  if (avail.length < minBars) {
    return base;
  }

  const closes = avail.map((c) => c.close);
  const highs = avail.map((c) => c.high);
  const lows = avail.map((c) => c.low);
  const period = Math.min(14, Math.floor(avail.length / 2));
  const atrVal = atr(highs, lows, closes, period);
  const sl = slope(closes, period);
  const r2 = rSquared(closes.slice(-period));
  const ts = trendStrength(closes, period, 1);
  const structure = structurePattern(closes, highs, lows);

  const last = closes[closes.length - 1]!;
  const prev = closes[closes.length - 2]!;
  const ret = (last - prev) / Math.max(Math.abs(prev), 1e-9);

  const ranges = avail.map((c) => c.high - c.low);
  const avgRange = sma(ranges, Math.min(20, ranges.length));
  const lastRange = ranges[ranges.length - 1]!;
  const compression =
    avgRange && avgRange > 0 ? clamp(1 - lastRange / avgRange, 0, 1) : null;
  const expansion =
    avgRange && avgRange > 0 ? clamp(lastRange / avgRange - 1, 0, 1) : null;

  // Volatility percentile vs recent ranges
  const sorted = [...ranges].sort((a, b) => a - b);
  const rank = sorted.findIndex((x) => x >= lastRange);
  const volPct = rank < 0 ? 1 : rank / Math.max(sorted.length - 1, 1);

  const direction = clamp((sl ?? 0) / Math.max(Math.abs(last) * 0.0001, 1e-9), -1, 1);
  const momentum = clamp(ret / Math.max(Math.abs(atrVal ?? last * 0.001), 1e-9), -1, 1);

  const structureScore =
    structure === 'HH_HL' ? 0.8 : structure === 'LH_LL' ? -0.8 : structure === 'MIXED' ? 0 : null;

  const breakout =
    atrVal && avgRange
      ? clamp(Math.abs(last - closes[closes.length - 6]!) / Math.max(atrVal, 1e-9) - 1, 0, 1)
      : null;

  const noise =
    r2 == null ? null : clamp(1 - r2, 0, 1);

  const reversal =
    structureScore != null && momentum != null && Math.sign(structureScore) !== Math.sign(momentum)
      ? clamp(Math.abs(momentum) * (noise ?? 0.5), 0, 1)
      : 0;

  const vector: MarketStateVector = {
    instrument: input.instrument,
    as_of: input.asOf,
    direction_score: direction,
    trend_strength: ts == null ? null : clamp(Math.abs(ts), 0, 1),
    trend_quality: r2,
    volatility_percentile: volPct,
    compression_score: compression,
    expansion_score: expansion,
    momentum_score: momentum,
    structure_score: structureScore,
    breakout_score: breakout,
    reversal_pressure: reversal,
    noise_score: noise,
    liquidity_score: input.spreadQuality ?? null,
    spread_quality: input.spreadQuality ?? null,
    feed_confidence: input.feedConfidence ?? null,
    label: null,
    inputs: {
      bar_count: avail.length,
      atr: atrVal,
      slope: sl,
      r_squared: r2,
      hh_hl_lh_ll: structure,
    },
    status: 'OK',
  };
  vector.label = interpretLabel(vector);
  return vector;
}
