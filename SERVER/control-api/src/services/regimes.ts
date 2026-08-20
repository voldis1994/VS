/**
 * Regime classifier from closed 10s OHLC.
 * RANGE is a proven regime (evidence required) — never an EMA/Donchian fallback.
 * INTERNAL_STRUCTURE (BULLISH/BEARISH/NEUTRAL) can coexist with macro RANGE.
 */

import type { TenSecBar } from './tenSecondOhlc.js';
import { bodyPct, rangePct } from './tenSecondOhlc.js';

export const REGIME_NAMES = [
  'UNKNOWN',
  'RANGE',
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
  'COMPRESSION',
  'EXPANSION',
  'BREAKOUT_UP',
  'BREAKOUT_DOWN',
  'FAILED_BREAKOUT_UP',
  'FAILED_BREAKOUT_DOWN',
  'REVERSAL_CANDIDATE',
  'TRANSITION',
] as const;

export type RegimeName = (typeof REGIME_NAMES)[number];

export type InternalStructure = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export const OPERATING_MODES = ['REPLAY', 'PAPER', 'DEMO', 'LIVE'] as const;
export type OperatingModeName = (typeof OPERATING_MODES)[number];

export const TRADE_TYPE_NAMES = ['BUY LONG', 'SELL LONG', 'BUY SCALP', 'SELL SCALP'] as const;
export type TradeTypeName = (typeof TRADE_TYPE_NAMES)[number];

export type TradeStyle = 'LONG' | 'SCALP';

const LONG_REGIMES = new Set<string>([
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
]);

const SCALP_REGIMES = new Set<string>([
  'BREAKOUT_UP',
  'BREAKOUT_DOWN',
  'FAILED_BREAKOUT_UP',
  'FAILED_BREAKOUT_DOWN',
  'COMPRESSION',
  'EXPANSION',
  'RANGE',
  'REVERSAL_CANDIDATE',
  'TRANSITION',
]);

/** Bars of opposite evidence required before TREND_* → RANGE. */
export const TREND_TO_RANGE_MIN_BARS = 3;

export function isRegimeName(value: string | null | undefined): value is RegimeName {
  const v = String(value || '').toUpperCase();
  return (REGIME_NAMES as readonly string[]).includes(v);
}

export function parseRegimeFromExplanation(text?: string | null): RegimeName | null {
  if (!text) return null;
  const m = String(text).match(/REGIME:\s*\n?\s*([A-Z_]+)/i);
  if (!m) return null;
  const name = m[1]!.toUpperCase();
  return isRegimeName(name) ? name : null;
}

export function normalizeRegime(value: string | null | undefined): RegimeName {
  const v = String(value || '')
    .trim()
    .toUpperCase();
  return isRegimeName(v) ? v : 'UNKNOWN';
}

export function styleFromClassification(
  regime?: string | null,
  setupType?: string | null,
  side?: string | null
): TradeStyle | null {
  const setup = String(setupType || '')
    .trim()
    .toUpperCase();
  const dir = String(side || '')
    .trim()
    .toUpperCase();
  const r = String(regime || '')
    .trim()
    .toUpperCase();
  if (dir === 'SELL' && (r === 'TREND_UP' || r === 'PULLBACK_UPTREND')) return null;
  if (dir === 'BUY' && (r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND')) return null;
  if (setup === 'CONTINUATION' || setup === 'PULLBACK') return 'LONG';
  if (
    setup === 'BREAKOUT' ||
    setup === 'FADE' ||
    setup === 'REVERSAL' ||
    setup === 'FAILED_BREAKOUT' ||
    setup === 'RANGE_REJECTION'
  ) {
    return 'SCALP';
  }
  if (LONG_REGIMES.has(r)) return 'LONG';
  if (SCALP_REGIMES.has(r)) return 'SCALP';
  return null;
}

export type RegimeSnapshot = {
  epic: string;
  display_name: string;
  current: RegimeName;
  previous: RegimeName;
  confidence: number;
  since: string;
  last_update: string;
  last_mid: number | null;
  bar_count: number;
  internal_structure: InternalStructure;
  range_width_atr: number | null;
  midpoint_slope: number | null;
  directional_displacement: number | null;
  range_efficiency: number | null;
  edge_touches: number | null;
  midpoint_crossings: number | null;
};

export type RangeEvidence = {
  ok: boolean;
  score: number;
  width_atr: number;
  midpoint_slope: number;
  directional_displacement: number;
  range_efficiency: number;
  edge_touches: number;
  midpoint_crossings: number;
  horizontal_center: boolean;
  evidence: string[];
};

export type StructureView = {
  structure: InternalStructure;
  hh: number;
  hl: number;
  lh: number;
  ll: number;
  swing_highs: number[];
  swing_lows: number[];
};

export type RegimeClassification = {
  regime: RegimeName;
  previous: RegimeName;
  confidence: number;
  internal_structure: InternalStructure;
  structure: StructureView;
  range: RangeEvidence;
  evidence: string[];
  raw_regime: RegimeName;
};

type Book = {
  bars: TenSecBar[];
  current: RegimeName;
  previous: RegimeName;
  confidence: number;
  since: string;
  display_name: string;
  last_mid: number | null;
  last_update: string;
  internal_structure: InternalStructure;
  /** Candidate for hysteresis (TREND → RANGE must dwell). */
  hyst_candidate: RegimeName | null;
  hyst_count: number;
  range_width_atr: number | null;
  midpoint_slope: number | null;
  directional_displacement: number | null;
  range_efficiency: number | null;
  edge_touches: number | null;
  midpoint_crossings: number | null;
};

const MAX_BARS = 48;
const books = new Map<string, Book>();

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function epicKey(epic: string): string {
  return String(epic || '').trim().toUpperCase();
}

function atrFromBars(bars: TenSecBar[], n = 14): number {
  const w = bars.slice(-Math.max(n + 1, 3));
  if (w.length < 2) {
    const b = w[0];
    return b ? Math.max(b.high - b.low, 1e-9) : 1e-9;
  }
  let sum = 0;
  for (let i = 1; i < w.length; i++) {
    const cur = w[i]!;
    const prev = w[i - 1]!;
    sum += Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
  }
  return Math.max(sum / (w.length - 1), 1e-9);
}

/** Local swing pivots from 10s bars (not full-window Donchian). */
export function detectSwingPivots(bars: TenSecBar[], lookback = 24): {
  highs: Array<{ i: number; price: number }>;
  lows: Array<{ i: number; price: number }>;
} {
  const w = bars.slice(-lookback);
  const highs: Array<{ i: number; price: number }> = [];
  const lows: Array<{ i: number; price: number }> = [];
  if (w.length < 3) return { highs, lows };
  for (let i = 1; i < w.length - 1; i++) {
    const a = w[i - 1]!;
    const b = w[i]!;
    const c = w[i + 1]!;
    if (b.high >= a.high && b.high >= c.high) highs.push({ i, price: b.high });
    if (b.low <= a.low && b.low <= c.low) lows.push({ i, price: b.low });
  }
  return { highs, lows };
}

/**
 * INTERNAL STRUCTURE from 10s swings:
 * HH+HL → BULLISH · LH+LL → BEARISH · else NEUTRAL.
 */
export function detectInternalStructure(bars: TenSecBar[]): StructureView {
  const piv = detectSwingPivots(bars, 24);
  const sh = piv.highs.map((p) => p.price);
  const sl = piv.lows.map((p) => p.price);
  let hh = 0;
  let lh = 0;
  let hl = 0;
  let ll = 0;
  for (let i = 1; i < sh.length; i++) {
    if (sh[i]! > sh[i - 1]!) hh += 1;
    else if (sh[i]! < sh[i - 1]!) lh += 1;
  }
  for (let i = 1; i < sl.length; i++) {
    if (sl[i]! > sl[i - 1]!) hl += 1;
    else if (sl[i]! < sl[i - 1]!) ll += 1;
  }

  // Fallback when few pivots: compare successive bar extremes in recent window
  if (sh.length < 2 || sl.length < 2) {
    const w = bars.slice(-8);
    for (let i = 2; i < w.length; i++) {
      const h0 = w[i - 2]!.high;
      const h1 = w[i]!.high;
      const l0 = w[i - 2]!.low;
      const l1 = w[i]!.low;
      if (h1 > h0) hh += 1;
      else if (h1 < h0) lh += 1;
      if (l1 > l0) hl += 1;
      else if (l1 < l0) ll += 1;
    }
  }

  let structure: InternalStructure = 'NEUTRAL';
  if (hh >= lh && hl >= ll && hh + hl >= 2 && hh + hl > lh + ll) structure = 'BULLISH';
  else if (lh >= hh && ll >= hl && lh + ll >= 2 && lh + ll > hh + hl) structure = 'BEARISH';

  return {
    structure,
    hh,
    hl,
    lh,
    ll,
    swing_highs: sh.slice(-6),
    swing_lows: sl.slice(-6),
  };
}

/**
 * RANGE evidence — Donchian alone is NOT enough.
 * Requires horizontal center, edge respect, midpoint crossings, low directional efficiency,
 * no dominant HH/HL or LH/LL, and sane width/ATR.
 */
export function evaluateRangeEvidence(bars: TenSecBar[], structure: StructureView): RangeEvidence {
  const evidence: string[] = [];
  const empty: RangeEvidence = {
    ok: false,
    score: 0,
    width_atr: 0,
    midpoint_slope: 0,
    directional_displacement: 0,
    range_efficiency: 0,
    edge_touches: 0,
    midpoint_crossings: 0,
    horizontal_center: false,
    evidence: ['INSUFFICIENT_BARS'],
  };
  if (bars.length < 6) return empty;

  const w = bars.slice(-16);
  const atr = atrFromBars(w, 14);
  const hi = Math.max(...w.map((b) => b.high));
  const lo = Math.min(...w.map((b) => b.low));
  const width = Math.max(hi - lo, 1e-9);
  const width_atr = width / atr;
  const mid = (hi + lo) / 2;

  // Midpoint path of successive half-windows
  const half = Math.max(3, Math.floor(w.length / 2));
  const early = w.slice(0, half);
  const late = w.slice(-half);
  const midEarly =
    (Math.max(...early.map((b) => b.high)) + Math.min(...early.map((b) => b.low))) / 2;
  const midLate =
    (Math.max(...late.map((b) => b.high)) + Math.min(...late.map((b) => b.low))) / 2;
  const midpoint_slope = (midLate - midEarly) / atr;

  const first = w[0]!;
  const last = w[w.length - 1]!;
  const directional_displacement = Math.abs(last.close - first.open) / atr;

  let path = 0;
  for (let i = 1; i < w.length; i++) {
    path += Math.abs(w[i]!.close - w[i - 1]!.close);
  }
  const net = Math.abs(last.close - first.open);
  const dirEff = path > 1e-12 ? net / path : 1;
  const range_efficiency = Math.max(0, Math.min(1, 1 - dirEff));

  const band = width * 0.12;
  let edge_touches = 0;
  let midpoint_crossings = 0;
  let prevSide = 0;
  for (const b of w) {
    if (b.high >= hi - band) edge_touches += 1;
    if (b.low <= lo + band) edge_touches += 1;
    const side = b.close >= mid ? 1 : -1;
    if (prevSide && side !== prevSide) midpoint_crossings += 1;
    prevSide = side;
  }

  const horizontal_center = Math.abs(midpoint_slope) < 0.35;
  const widthOk = width_atr >= 0.8 && width_atr <= 8.0;
  const dominantBull = structure.structure === 'BULLISH' && structure.hh + structure.hl >= 3;
  const dominantBear = structure.structure === 'BEARISH' && structure.lh + structure.ll >= 3;
  const noDominantTrendStruct = !dominantBull && !dominantBear;

  let score = 0;
  if (horizontal_center) {
    score += 0.2;
    evidence.push('HORIZONTAL_CENTER');
  }
  if (edge_touches >= 3) {
    score += 0.2;
    evidence.push(`EDGE_TOUCHES=${edge_touches}`);
  }
  if (midpoint_crossings >= 2) {
    score += 0.2;
    evidence.push(`MID_CROSS=${midpoint_crossings}`);
  }
  if (range_efficiency >= 0.45) {
    score += 0.15;
    evidence.push(`RANGE_EFF=${range_efficiency.toFixed(2)}`);
  }
  if (directional_displacement < 1.2) {
    score += 0.1;
    evidence.push(`DISP=${directional_displacement.toFixed(2)}`);
  }
  if (widthOk) {
    score += 0.1;
    evidence.push(`WIDTH_ATR=${width_atr.toFixed(2)}`);
  }
  if (noDominantTrendStruct) {
    score += 0.15;
    evidence.push('NO_DOMINANT_HHHL_LHLL');
  } else {
    evidence.push(
      dominantBear ? 'DOMINANT_BEAR_STRUCT' : dominantBull ? 'DOMINANT_BULL_STRUCT' : 'STRUCT'
    );
  }

  // Proven RANGE needs multiple independent signals — not Donchian alone
  const ok =
    score >= 0.55 &&
    horizontal_center &&
    widthOk &&
    range_efficiency >= 0.4 &&
    midpoint_crossings >= 2 &&
    edge_touches >= 2 &&
    directional_displacement < 1.6 &&
    noDominantTrendStruct;

  if (!ok) evidence.push('RANGE_NOT_PROVEN');

  return {
    ok,
    score,
    width_atr,
    midpoint_slope,
    directional_displacement,
    range_efficiency,
    edge_touches,
    midpoint_crossings,
    horizontal_center,
    evidence,
  };
}

/**
 * Persistence / hysteresis: TREND_* must not flip to RANGE on one unclear bar.
 * Path: TREND → TRANSITION → RANGE only with proven range evidence.
 */
export function applyRegimeHysteresis(input: {
  previous: RegimeName;
  raw: RegimeName;
  range: RangeEvidence;
  structure: StructureView;
  hyst_candidate: RegimeName | null;
  hyst_count: number;
}): { regime: RegimeName; hyst_candidate: RegimeName | null; hyst_count: number } {
  const { previous, raw, range, structure } = input;
  let { hyst_candidate, hyst_count } = input;

  const trendPrev = previous === 'TREND_UP' || previous === 'TREND_DOWN';
  const rawWantsRange = raw === 'RANGE';

  // Strong structure continues the trend even if EMA/window looks mixed
  if (previous === 'TREND_DOWN' && structure.structure === 'BEARISH' && range.directional_displacement >= 0.9) {
    if (raw === 'RANGE' || raw === 'TRANSITION' || raw === 'UNKNOWN') {
      return { regime: 'TREND_DOWN', hyst_candidate: null, hyst_count: 0 };
    }
  }
  if (previous === 'TREND_UP' && structure.structure === 'BULLISH' && range.directional_displacement >= 0.9) {
    if (raw === 'RANGE' || raw === 'TRANSITION' || raw === 'UNKNOWN') {
      return { regime: 'TREND_UP', hyst_candidate: null, hyst_count: 0 };
    }
  }

  if (trendPrev && rawWantsRange) {
    if (!range.ok) {
      return { regime: 'TRANSITION', hyst_candidate: 'RANGE', hyst_count: Math.min(hyst_count + 1, 99) };
    }
    const cand = hyst_candidate === 'RANGE' ? hyst_count + 1 : 1;
    if (cand < TREND_TO_RANGE_MIN_BARS) {
      return { regime: 'TRANSITION', hyst_candidate: 'RANGE', hyst_count: cand };
    }
    return { regime: 'RANGE', hyst_candidate: null, hyst_count: 0 };
  }

  if (previous === 'TRANSITION' && rawWantsRange) {
    if (!range.ok) {
      return { regime: 'TRANSITION', hyst_candidate: 'RANGE', hyst_count: hyst_count + 1 };
    }
    const cand = hyst_candidate === 'RANGE' ? hyst_count + 1 : 1;
    if (cand < 2) {
      return { regime: 'TRANSITION', hyst_candidate: 'RANGE', hyst_count: cand };
    }
    return { regime: 'RANGE', hyst_candidate: null, hyst_count: 0 };
  }

  if (raw === previous) {
    return { regime: raw, hyst_candidate: null, hyst_count: 0 };
  }

  // Fresh non-range transitions clear hysteresis
  return { regime: raw, hyst_candidate: null, hyst_count: 0 };
}

function rawClassify(bars: TenSecBar[], previous: RegimeName, structure: StructureView, range: RangeEvidence): RegimeName {
  if (!bars.length || bars.length < 2) return 'UNKNOWN';

  const window = bars.slice(-8);
  const last = window[window.length - 1]!;
  const prior = window.slice(0, -1);
  if (!prior.length) return 'UNKNOWN';

  const velocities = window.map(bodyPct);
  const ranges = window.map(rangePct);
  const priorRanges = prior.map(rangePct);
  const avgRange = Math.max(mean(priorRanges.length ? priorRanges : ranges), 1e-9);
  const lastVel = bodyPct(last);
  const lastRange = rangePct(last);
  const persistWindow = velocities.slice(-6);
  const persistence = mean(
    persistWindow.map((v) => (v > 0.00008 ? 1 : v < -0.00008 ? -1 : 0))
  );

  const trendingUp = persistence > 0.5 && lastVel > 0.00008;
  const trendingDown = persistence < -0.5 && lastVel < -0.00008;
  const compressed = lastRange < avgRange * 0.55 && lastRange < 0.00022;
  const expanding = lastRange > avgRange * 1.45 && lastRange >= 0.00025;
  const hi = Math.max(...prior.map((b) => b.high));
  const lo = Math.min(...prior.map((b) => b.low));
  const inRange = last.close <= hi && last.close >= lo;
  const breakoutUp = last.close > hi;
  const breakoutDown = last.close < lo;
  const first = window[0]!;
  const net = (last.close - first.open) / Math.max(Math.abs(first.open), 1e-9);
  const reversal =
    (previous === 'TREND_UP' && lastVel < -0.0012 && lastRange > avgRange && !breakoutDown) ||
    (previous === 'TREND_DOWN' && lastVel > 0.0012 && lastRange > avgRange && !breakoutUp);

  // Strong LH/LL with displacement — never soft-fallback to RANGE
  const bearStruct =
    structure.structure === 'BEARISH' &&
    structure.lh + structure.ll >= 3 &&
    range.directional_displacement >= 1.0;
  const bullStruct =
    structure.structure === 'BULLISH' &&
    structure.hh + structure.hl >= 3 &&
    range.directional_displacement >= 1.0;

  if (previous === 'BREAKOUT_UP' && inRange && lastVel < 0) return 'FAILED_BREAKOUT_UP';
  if (previous === 'BREAKOUT_DOWN' && inRange && lastVel > 0) return 'FAILED_BREAKOUT_DOWN';
  // Tiny coiled bars — compression without requiring full RANGE proof
  if (compressed && inRange) return 'COMPRESSION';
  if (expanding && breakoutUp && (trendingUp || lastVel > 0 || bullStruct)) return 'BREAKOUT_UP';
  if (expanding && breakoutDown && (trendingDown || lastVel < 0 || bearStruct)) return 'BREAKOUT_DOWN';
  if (expanding && !bearStruct && !bullStruct) return 'EXPANSION';

  // Pullback while prior trend still owns structure — before locking TREND again
  if (previous === 'TREND_UP' && lastVel < -0.00008 && persistence > 0.2) {
    return 'PULLBACK_UPTREND';
  }
  if (previous === 'TREND_DOWN' && lastVel > 0.00008 && persistence < -0.2) {
    return 'PULLBACK_DOWNTREND';
  }

  if (bearStruct) return 'TREND_DOWN';
  if (bullStruct) return 'TREND_UP';

  if (trendingUp && structure.structure !== 'BEARISH') return 'TREND_UP';
  if (trendingDown && structure.structure !== 'BULLISH') return 'TREND_DOWN';
  if (reversal) return 'REVERSAL_CANDIDATE';

  // Proven RANGE only
  if (range.ok) return 'RANGE';

  if (net > 0.0008 && (persistence > 0.35 || structure.structure === 'BULLISH')) return 'TREND_UP';
  if (net < -0.0008 && (persistence < -0.35 || structure.structure === 'BEARISH')) return 'TREND_DOWN';

  if (previous === 'TREND_UP' || previous === 'TREND_DOWN' || previous === 'TRANSITION') {
    return 'TRANSITION';
  }
  if (window.length >= 4) return 'TRANSITION';
  return 'UNKNOWN';
}

/**
 * Full classification: regime + internal structure + range metrics + hysteresis.
 */
export function classifyRegimeDetailed(
  bars: TenSecBar[],
  previous: RegimeName = 'UNKNOWN',
  hyst: { candidate: RegimeName | null; count: number } = { candidate: null, count: 0 }
): RegimeClassification {
  const structure = detectInternalStructure(bars);
  const range = evaluateRangeEvidence(bars, structure);
  const raw = rawClassify(bars, previous, structure, range);
  const applied = applyRegimeHysteresis({
    previous,
    raw,
    range,
    structure,
    hyst_candidate: hyst.candidate,
    hyst_count: hyst.count,
  });

  const evidence = [
    ...range.evidence,
    `STRUCT=${structure.structure}`,
    `HH=${structure.hh}/HL=${structure.hl}/LH=${structure.lh}/LL=${structure.ll}`,
    `RAW=${raw}`,
    `FINAL=${applied.regime}`,
  ];

  let confidence = 0.35;
  if (applied.regime === 'RANGE' && range.ok) confidence = Math.min(0.95, 0.45 + range.score);
  else if (applied.regime === 'TREND_UP' || applied.regime === 'TREND_DOWN') {
    confidence = Math.min(
      0.95,
      0.5 + Math.min(0.35, range.directional_displacement * 0.15) + (structure.structure !== 'NEUTRAL' ? 0.1 : 0)
    );
  } else if (applied.regime === 'TRANSITION') confidence = 0.4;
  else if (applied.regime !== 'UNKNOWN') confidence = 0.5;

  return {
    regime: applied.regime,
    previous,
    confidence,
    internal_structure: structure.structure,
    structure,
    range,
    evidence,
    raw_regime: raw,
  };
}

/**
 * Classify from closed 10s OHLC — same names as C++ RegimeEngine.
 * RANGE only when proven; LH/LL sequences are not soft-RANGE.
 */
export function classifyRegime(bars: TenSecBar[], previous: RegimeName = 'UNKNOWN'): RegimeName {
  return classifyRegimeDetailed(bars, previous).regime;
}

function confidenceFrom(bars: TenSecBar[], regime: RegimeName): number {
  if (regime === 'UNKNOWN' || bars.length < 2) return 0;
  const last = bars[bars.length - 1]!;
  const strength = Math.min(1, Math.abs(bodyPct(last)) / 0.0008 + rangePct(last) / 0.001);
  return Math.max(0.2, Math.min(0.95, 0.35 + strength * 0.5));
}

function toSnapshot(epic: string, b: Book): RegimeSnapshot {
  return {
    epic,
    display_name: b.display_name || epic,
    current: b.current,
    previous: b.previous,
    confidence: b.confidence,
    since: b.since,
    last_update: b.last_update,
    last_mid: b.last_mid,
    bar_count: b.bars.length,
    internal_structure: b.internal_structure,
    range_width_atr: b.range_width_atr,
    midpoint_slope: b.midpoint_slope,
    directional_displacement: b.directional_displacement,
    range_efficiency: b.range_efficiency,
    edge_touches: b.edge_touches,
    midpoint_crossings: b.midpoint_crossings,
  };
}

function ensureBook(epic: string, displayName?: string): Book {
  const key = epicKey(epic);
  let b = books.get(key);
  if (!b) {
    const now = new Date().toISOString();
    b = {
      bars: [],
      current: 'UNKNOWN',
      previous: 'UNKNOWN',
      confidence: 0,
      since: now,
      display_name: displayName || epic,
      last_mid: null,
      last_update: now,
      internal_structure: 'NEUTRAL',
      hyst_candidate: null,
      hyst_count: 0,
      range_width_atr: null,
      midpoint_slope: null,
      directional_displacement: null,
      range_efficiency: null,
      edge_touches: null,
      midpoint_crossings: null,
    };
    books.set(key, b);
  } else if (displayName) {
    b.display_name = displayName;
  }
  return b;
}

function applyClassify(epic: string, b: Book): RegimeSnapshot {
  const detailed = classifyRegimeDetailed(b.bars, b.current, {
    candidate: b.hyst_candidate,
    count: b.hyst_count,
  });
  // Re-run hysteresis against book previous for dwell
  const applied = applyRegimeHysteresis({
    previous: b.current,
    raw: detailed.raw_regime,
    range: detailed.range,
    structure: detailed.structure,
    hyst_candidate: b.hyst_candidate,
    hyst_count: b.hyst_count,
  });
  const now = new Date().toISOString();
  const next = applied.regime;
  b.hyst_candidate = applied.hyst_candidate;
  b.hyst_count = applied.hyst_count;
  if (next !== b.current) {
    b.previous = b.current;
    b.current = next;
    b.since = now;
  }
  b.internal_structure = detailed.internal_structure;
  b.range_width_atr = detailed.range.width_atr;
  b.midpoint_slope = detailed.range.midpoint_slope;
  b.directional_displacement = detailed.range.directional_displacement;
  b.range_efficiency = detailed.range.range_efficiency;
  b.edge_touches = detailed.range.edge_touches;
  b.midpoint_crossings = detailed.range.midpoint_crossings;
  b.confidence = Math.max(confidenceFrom(b.bars, b.current), detailed.confidence);
  b.last_update = now;
  if (b.bars.length) b.last_mid = b.bars[b.bars.length - 1]!.close;
  return toSnapshot(epic, b);
}

export function observeClosedBars(
  epic: string,
  bars: TenSecBar[],
  displayName?: string
): RegimeSnapshot {
  const key = epicKey(epic);
  const b = ensureBook(epic, displayName);
  for (const bar of bars) {
    if (!bar || !Number.isFinite(bar.close)) continue;
    const last = b.bars[b.bars.length - 1];
    const same =
      last &&
      Math.abs(last.open - bar.open) < 1e-9 &&
      Math.abs(last.close - bar.close) < 1e-9 &&
      Math.abs(last.high - bar.high) < 1e-9;
    if (same) continue;
    b.bars.push(bar);
  }
  if (b.bars.length > MAX_BARS) b.bars.splice(0, b.bars.length - MAX_BARS);
  return applyClassify(key, b);
}

export function notePipelineRegime(
  epic: string,
  regime: string | null | undefined,
  displayName?: string
): RegimeSnapshot {
  const b = ensureBook(epic, displayName);
  const next = normalizeRegime(regime);
  const now = new Date().toISOString();
  if (next !== b.current) {
    b.previous = b.current;
    b.current = next;
    b.since = now;
  }
  b.last_update = now;
  if (next !== 'UNKNOWN') b.confidence = Math.max(b.confidence, 0.55);
  return toSnapshot(epicKey(epic), b);
}

export function currentRegime(epic: string | null | undefined): RegimeSnapshot | null {
  if (!epic) return null;
  const b = books.get(epicKey(epic));
  if (!b) return null;
  return toSnapshot(epicKey(epic), b);
}

export function listRegimeSnapshots(): RegimeSnapshot[] {
  return [...books.entries()].map(([epic, b]) => toSnapshot(epic, b));
}

export function regimeCatalog() {
  return REGIME_NAMES.map((name) => ({
    name,
    kind: styleFromClassification(name) || 'NONE',
  }));
}

/** Test helper */
export function resetRegimeBook(): void {
  books.clear();
}
