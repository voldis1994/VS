/**
 * Final entry direction gate — trend-aware permission before Capital execution.
 * Trend is a GATE, not an entry trigger. Reuses closed 10s OHLC + existing bias/regime.
 */
import {
  trendBiasFromBars,
  type TrendBias,
} from './entryFromRegime.js';
import { bodyPct, type TenSecBar } from './tenSecondOhlc.js';

export type MarketTrend =
  | 'STRONG_UP'
  | 'UP'
  | 'RANGE'
  | 'DOWN'
  | 'STRONG_DOWN'
  | 'UNCERTAIN';

export type MarketStructure =
  | 'HIGHER_HIGH_HIGHER_LOW'
  | 'LOWER_HIGH_LOWER_LOW'
  | 'MIXED'
  | 'FLAT';

export type MomentumBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export type EntryQuality = 'HIGH' | 'MEDIUM' | 'LOW' | 'BLOCKED';

export type EntryDirectionVerdict = {
  entry_direction: 'BUY' | 'SELL';
  trend: MarketTrend;
  momentum: MomentumBias;
  structure: MarketStructure;
  reversal_confirmed: boolean;
  signal_age_ms: number | null;
  entry_quality: EntryQuality;
  final_entry: 'ALLOW' | 'BLOCK';
  block_reason: string | null;
  detail: string;
};

const MIN_BARS = 8;
const LOOKBACK = 18;
const STALE_SIGNAL_MS = 12_000;

function withBar(recent: TenSecBar[] | null | undefined, bar?: TenSecBar | null): TenSecBar[] {
  const w = (recent || []).filter((b) => b && Number.isFinite(b.close));
  if (!bar || !Number.isFinite(bar.close)) return w;
  const last = w[w.length - 1];
  const same =
    last &&
    Math.abs(last.open - bar.open) < 1e-9 &&
    Math.abs(last.close - bar.close) < 1e-9;
  if (!same) w.push(bar);
  return w;
}

function findSwingHighs(bars: TenSecBar[]): { idx: number; val: number }[] {
  const out: { idx: number; val: number }[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const h = bars[i]!.high;
    if (h >= bars[i - 1]!.high && h >= bars[i + 1]!.high) {
      out.push({ idx: i, val: h });
    }
  }
  return out;
}

function findSwingLows(bars: TenSecBar[]): { idx: number; val: number }[] {
  const out: { idx: number; val: number }[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const l = bars[i]!.low;
    if (l <= bars[i - 1]!.low && l <= bars[i + 1]!.low) {
      out.push({ idx: i, val: l });
    }
  }
  return out;
}

export function analyzeStructure(bars: TenSecBar[]): MarketStructure {
  const w = bars.slice(-LOOKBACK);
  if (w.length < 6) return 'FLAT';

  const highs = findSwingHighs(w);
  const lows = findSwingLows(w);

  if (highs.length >= 2 && lows.length >= 2) {
    const hh =
      highs[highs.length - 1]!.val > highs[highs.length - 2]!.val;
    const hl = lows[lows.length - 1]!.val > lows[lows.length - 2]!.val;
    const lh =
      highs[highs.length - 1]!.val < highs[highs.length - 2]!.val;
    const ll = lows[lows.length - 1]!.val < lows[lows.length - 2]!.val;
    if (hh && hl) return 'HIGHER_HIGH_HIGHER_LOW';
    if (lh && ll) return 'LOWER_HIGH_LOWER_LOW';
  }

  // Monotonic / stair-step trends may lack formal swing pivots — compare window thirds.
  const third = Math.max(2, Math.floor(w.length / 3));
  const early = w.slice(0, third);
  const mid = w.slice(third, 2 * third);
  const late = w.slice(2 * third);
  const earlyHi = Math.max(...early.map((b) => b.high));
  const earlyLo = Math.min(...early.map((b) => b.low));
  const midHi = Math.max(...mid.map((b) => b.high));
  const midLo = Math.min(...mid.map((b) => b.low));
  const lateHi = Math.max(...late.map((b) => b.high));
  const lateLo = Math.min(...late.map((b) => b.low));

  const hh = lateHi > midHi && midHi >= earlyHi;
  const hl = lateLo > midLo && midLo >= earlyLo;
  const lh = lateHi < midHi && midHi <= earlyHi;
  const ll = lateLo < midLo && midLo <= earlyLo;
  if (hh && hl) return 'HIGHER_HIGH_HIGHER_LOW';
  if (lh && ll) return 'LOWER_HIGH_LOWER_LOW';

  const net =
    (w[w.length - 1]!.close - w[0]!.open) / Math.max(Math.abs(w[0]!.open), 1e-9);
  if (Math.abs(net) < 0.00012) return 'FLAT';
  return 'MIXED';
}

export function momentumBias(bars: TenSecBar[], n = 5): MomentumBias {
  const w = bars.slice(-n);
  if (w.length < 3) return 'NEUTRAL';
  const bodySum = w.reduce((s, b) => s + bodyPct(b), 0);
  const net =
    (w[w.length - 1]!.close - w[0]!.open) / Math.max(Math.abs(w[0]!.open), 1e-9);
  if (bodySum > 0.00008 && net > 0) return 'BULLISH';
  if (bodySum < -0.00008 && net < 0) return 'BEARISH';
  return 'NEUTRAL';
}

function netSlope(bars: TenSecBar[]): number {
  const w = bars.slice(-LOOKBACK);
  if (w.length < 2) return 0;
  return (w[w.length - 1]!.close - w[0]!.open) / Math.max(Math.abs(w[0]!.open), 1e-9);
}

/** Classify canonical trend from closed 10s structure + momentum + existing bias/regime. */
export function classifyMarketTrend(
  bars: TenSecBar[],
  regime?: string | null,
  bias: TrendBias = 'FLAT'
): MarketTrend {
  if (bars.length < MIN_BARS) return 'UNCERTAIN';

  const structure = analyzeStructure(bars);
  const momentum = momentumBias(bars);
  const slope = netSlope(bars);
  const shortBias = trendBiasFromBars(bars);
  const r = String(regime || '').toUpperCase();

  const regimeUp = r.includes('TREND_UP') || r.includes('PULLBACK_UP') || r.includes('BREAKOUT_UP');
  const regimeDown =
    r.includes('TREND_DOWN') || r.includes('PULLBACK_DOWN') || r.includes('BREAKOUT_DOWN');

  const downSignals =
    (structure === 'LOWER_HIGH_LOWER_LOW' ? 2 : 0) +
    (momentum === 'BEARISH' ? 1 : 0) +
    (slope < -0.00025 ? 1 : 0) +
    (shortBias === 'DOWN' ? 1 : 0) +
    (bias === 'DOWN' ? 1 : 0) +
    (regimeDown ? 1 : 0);

  const upSignals =
    (structure === 'HIGHER_HIGH_HIGHER_LOW' ? 2 : 0) +
    (momentum === 'BULLISH' ? 1 : 0) +
    (slope > 0.00025 ? 1 : 0) +
    (shortBias === 'UP' ? 1 : 0) +
    (bias === 'UP' ? 1 : 0) +
    (regimeUp ? 1 : 0);

  if (downSignals >= 5) return 'STRONG_DOWN';
  if (upSignals >= 5) return 'STRONG_UP';
  if (downSignals >= 3 && downSignals > upSignals) return 'DOWN';
  if (upSignals >= 3 && upSignals > downSignals) return 'UP';

  if (structure === 'FLAT' || (Math.abs(slope) < 0.00015 && momentum === 'NEUTRAL')) {
    return 'RANGE';
  }
  if (structure === 'MIXED' && Math.abs(slope) < 0.0002) return 'RANGE';
  return 'UNCERTAIN';
}

/** Bullish structure reversal — not a single bounce. Requires multi-signal confirmation. */
export function confirmBullishReversal(
  bars: TenSecBar[],
  regime?: string | null
): boolean {
  const w = bars.filter((b) => b && Number.isFinite(b.close));
  if (w.length < 8) return false;

  let score = 0;
  const swingLows = findSwingLows(w);
  const swingHighs = findSwingHighs(w);

  if (
    swingLows.length >= 2 &&
    swingLows[swingLows.length - 1]!.val > swingLows[swingLows.length - 2]!.val
  ) {
    score++;
  }

  if (swingHighs.length >= 2) {
    const prevHigh = swingHighs[swingHighs.length - 2]!.val;
    if (w[w.length - 1]!.close > prevHigh) score++;
  }

  const priorMin = Math.min(...w.slice(-8, -2).map((b) => b.low));
  if (w[w.length - 1]!.low > priorMin) score++;

  const recent = w.slice(-4);
  const netRecent =
    (recent[recent.length - 1]!.close - recent[0]!.open) /
    Math.max(Math.abs(recent[0]!.open), 1e-9);
  const greenN = recent.filter((b) => b.close > b.open).length;
  if (netRecent > 0.0002 && greenN >= 3) score++;

  const r = String(regime || '').toUpperCase();
  if (r.includes('REVERSAL') || r.includes('PULLBACK_UP') || r === 'TREND_UP') score++;

  return score >= 3;
}

/** Bearish structure reversal — symmetric to bullish. */
export function confirmBearishReversal(
  bars: TenSecBar[],
  regime?: string | null
): boolean {
  const w = bars.filter((b) => b && Number.isFinite(b.close));
  if (w.length < 8) return false;

  let score = 0;
  const swingLows = findSwingLows(w);
  const swingHighs = findSwingHighs(w);

  if (
    swingHighs.length >= 2 &&
    swingHighs[swingHighs.length - 1]!.val < swingHighs[swingHighs.length - 2]!.val
  ) {
    score++;
  }

  if (swingLows.length >= 2) {
    const prevLow = swingLows[swingLows.length - 2]!.val;
    if (w[w.length - 1]!.close < prevLow) score++;
  }

  const priorMax = Math.max(...w.slice(-8, -2).map((b) => b.high));
  if (w[w.length - 1]!.high < priorMax) score++;

  const recent = w.slice(-4);
  const netRecent =
    (recent[recent.length - 1]!.close - recent[0]!.open) /
    Math.max(Math.abs(recent[0]!.open), 1e-9);
  const redN = recent.filter((b) => b.close < b.open).length;
  if (netRecent < -0.0002 && redN >= 3) score++;

  const r = String(regime || '').toUpperCase();
  if (r.includes('REVERSAL') || r.includes('PULLBACK_DOWN') || r === 'TREND_DOWN') score++;

  return score >= 3;
}

function entryQualityFor(
  direction: 'BUY' | 'SELL',
  trend: MarketTrend,
  reversalConfirmed: boolean
): EntryQuality {
  const withTrend =
    (direction === 'BUY' && (trend === 'UP' || trend === 'STRONG_UP')) ||
    (direction === 'SELL' && (trend === 'DOWN' || trend === 'STRONG_DOWN'));
  if (withTrend) return trend.startsWith('STRONG') ? 'HIGH' : 'MEDIUM';
  if (reversalConfirmed) return 'MEDIUM';
  if (trend === 'RANGE' || trend === 'UNCERTAIN') return 'MEDIUM';
  return 'LOW';
}

export function formatEntryDiagnostic(v: EntryDirectionVerdict): string {
  return [
    `ENTRY_DIRECTION=${v.entry_direction}`,
    `TREND=${v.trend}`,
    `MOMENTUM=${v.momentum}`,
    `STRUCTURE=${v.structure}`,
    `REVERSAL_CONFIRMED=${v.reversal_confirmed}`,
    v.signal_age_ms != null ? `SIGNAL_AGE=${Math.round(v.signal_age_ms / 1000)}s` : 'SIGNAL_AGE=n/a',
    `ENTRY_QUALITY=${v.entry_quality}`,
    `FINAL_ENTRY=${v.final_entry}`,
    v.block_reason ? `BLOCK_REASON=${v.block_reason}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Mandatory last check before Capital order — blocks counter-trend without confirmed reversal. */
export function evaluateEntryDirectionGate(input: {
  direction: 'BUY' | 'SELL';
  closedBars?: TenSecBar[] | null;
  bar?: TenSecBar | null;
  regime?: string | null;
  bias?: TrendBias;
  setup?: string | null;
  signalAgeMs?: number | null;
}): EntryDirectionVerdict {
  const bars = withBar(input.closedBars, input.bar);
  const bias = input.bias || 'FLAT';
  const trend = classifyMarketTrend(bars, input.regime, bias);
  const structure = analyzeStructure(bars);
  const momentum = momentumBias(bars);
  const reversalConfirmed =
    input.direction === 'BUY'
      ? confirmBullishReversal(bars, input.regime)
      : confirmBearishReversal(bars, input.regime);
  const signalAge = input.signalAgeMs ?? null;

  const base: Omit<EntryDirectionVerdict, 'final_entry' | 'block_reason' | 'entry_quality' | 'detail'> = {
    entry_direction: input.direction,
    trend,
    momentum,
    structure,
    reversal_confirmed: reversalConfirmed,
    signal_age_ms: signalAge,
  };

  if (signalAge != null && signalAge > STALE_SIGNAL_MS) {
    const v: EntryDirectionVerdict = {
      ...base,
      entry_quality: 'BLOCKED',
      final_entry: 'BLOCK',
      block_reason: 'STALE_SIGNAL',
      detail: '',
    };
    v.detail = formatEntryDiagnostic(v);
    return v;
  }

  if (input.direction === 'BUY') {
    if (trend === 'STRONG_DOWN') {
      const v: EntryDirectionVerdict = {
        ...base,
        entry_quality: 'BLOCKED',
        final_entry: 'BLOCK',
        block_reason: 'BUY_AGAINST_STRONG_DOWNTREND',
        detail: '',
      };
      v.detail = formatEntryDiagnostic(v);
      return v;
    }
    if (trend === 'DOWN' && !reversalConfirmed) {
      const v: EntryDirectionVerdict = {
        ...base,
        entry_quality: 'BLOCKED',
        final_entry: 'BLOCK',
        block_reason: 'BUY_AGAINST_DOWNTREND_NO_REVERSAL',
        detail: '',
      };
      v.detail = formatEntryDiagnostic(v);
      return v;
    }
  }

  if (input.direction === 'SELL') {
    if (trend === 'STRONG_UP') {
      const v: EntryDirectionVerdict = {
        ...base,
        entry_quality: 'BLOCKED',
        final_entry: 'BLOCK',
        block_reason: 'SELL_AGAINST_STRONG_UPTREND',
        detail: '',
      };
      v.detail = formatEntryDiagnostic(v);
      return v;
    }
    if (trend === 'UP' && !reversalConfirmed) {
      const v: EntryDirectionVerdict = {
        ...base,
        entry_quality: 'BLOCKED',
        final_entry: 'BLOCK',
        block_reason: 'SELL_AGAINST_UPTREND_NO_REVERSAL',
        detail: '',
      };
      v.detail = formatEntryDiagnostic(v);
      return v;
    }
  }

  const quality = entryQualityFor(input.direction, trend, reversalConfirmed);
  const v: EntryDirectionVerdict = {
    ...base,
    entry_quality: quality,
    final_entry: 'ALLOW',
    block_reason: null,
    detail: '',
  };
  v.detail = formatEntryDiagnostic(v);
  return v;
}
