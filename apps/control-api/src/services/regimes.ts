/** Original spec §13 — all regime names. Regime is a market-state classifier, not an entry. */
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
  const v = String(value || '').trim().toUpperCase();
  return isRegimeName(v) ? v : 'UNKNOWN';
}

/**
 * Live path never surfaces UNKNOWN — it froze robots in WAIT forever.
 * Map stall regimes to EXPANSION so entry can follow the 10s candle.
 */
export function toLiveRegime(regime: RegimeName): RegimeName {
  if (regime === 'UNKNOWN' || regime === 'TRANSITION' || regime === 'COMPRESSION') {
    return 'EXPANSION';
  }
  return regime;
}

export function styleFromClassification(
  regime?: string | null,
  setupType?: string | null
): TradeStyle | null {
  const setup = String(setupType || '').trim().toUpperCase();
  if (setup === 'CONTINUATION' || setup === 'PULLBACK') return 'LONG';
  if (setup === 'BREAKOUT' || setup === 'FADE' || setup === 'REVERSAL') return 'SCALP';
  const r = String(regime || '').trim().toUpperCase();
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
};

const MAX_BARS = 48; // ~4h of 5m bars
/** Keep closedBars / impulse windows aligned with regime book. */
export const MAX_REGIME_BARS = MAX_BARS;

const books = new Map<string, Book>();

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function epicKey(epic: string): string {
  return String(epic || '').trim().toUpperCase();
}

/**
 * Classify from closed 5m OHLC — same names as C++ RegimeEngine.
 * Short slope (~6×5m ≈ 30m) + structure (~24×5m ≈ 2h).
 */
export function classifyRegime(bars: TenSecBar[], previous: RegimeName = 'UNKNOWN'): RegimeName {
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
    persistWindow.map((v) => (v > 0.00025 ? 1 : v < -0.00025 ? -1 : 0))
  );

  const trendingUp = persistence > 0.35 && lastVel > 0.00015;
  const trendingDown = persistence < -0.35 && lastVel < -0.00015;
  const compressed = lastRange < avgRange * 0.55 && lastRange < 0.0008;
  const expanding = lastRange > avgRange * 1.45 && lastRange >= 0.001;
  const hi = Math.max(...prior.map((b) => b.high));
  const lo = Math.min(...prior.map((b) => b.low));
  const inRange = last.close <= hi && last.close >= lo;
  const breakoutUp = last.close > hi;
  const breakoutDown = last.close < lo;
  const reversal =
    (previous === 'TREND_UP' && lastVel < -0.0025 && lastRange > avgRange && !breakoutDown) ||
    (previous === 'TREND_DOWN' && lastVel > 0.0025 && lastRange > avgRange && !breakoutUp);

  // Short ~30 min; structure ~2h. ~0.15% ≈ 7pt, ~0.25% ≈ 11.5pt on Gold ~4600
  let slopeUp = false;
  let slopeDown = false;
  let bounceInDown = false;
  let dipInUp = false;
  if (bars.length >= 4) {
    const shortBars = bars.slice(-6);
    const shortOpen = shortBars[0]!.open;
    const shortMid = Math.max(Math.abs(shortOpen), 1e-9);
    const shortPct = (last.close - shortOpen) / shortMid;
    const shortUp = shortPct >= 0.0012;
    const shortDown = shortPct <= -0.0012;

    let structUp = false;
    let structDown = false;
    if (bars.length >= 12) {
      const structBars = bars.slice(-24);
      const structOpen = structBars[0]!.open;
      const structMid = Math.max(Math.abs(structOpen), 1e-9);
      const structPct = (last.close - structOpen) / structMid;
      structUp = structPct >= 0.002;
      structDown = structPct <= -0.002;
      if (structDown && shortPct > 0.0008) bounceInDown = true;
      if (structUp && shortPct < -0.0008) dipInUp = true;
    }

    slopeDown = shortDown || structDown;
    slopeUp = shortUp || structUp;
    if (structDown && shortUp) {
      slopeDown = true;
      slopeUp = false;
    } else if (structUp && shortDown) {
      slopeUp = true;
      slopeDown = false;
    }
  }

  if (previous === 'BREAKOUT_UP' && inRange && lastVel < 0) return 'FAILED_BREAKOUT_UP';
  if (previous === 'BREAKOUT_DOWN' && inRange && lastVel > 0) return 'FAILED_BREAKOUT_DOWN';
  if (compressed && inRange && !slopeUp && !slopeDown) return 'COMPRESSION';
  if (expanding && breakoutUp && (trendingUp || lastVel > 0 || slopeUp)) return 'BREAKOUT_UP';
  if (expanding && breakoutDown && (trendingDown || lastVel < 0 || slopeDown)) return 'BREAKOUT_DOWN';
  if (expanding && !slopeUp && !slopeDown) return 'EXPANSION';
  if (previous === 'TREND_UP' && lastVel < -0.00025 && persistence > 0.15) {
    return 'PULLBACK_UPTREND';
  }
  if (previous === 'TREND_DOWN' && lastVel > 0.00025 && persistence < -0.15) {
    return 'PULLBACK_DOWNTREND';
  }
  if (bounceInDown) return 'PULLBACK_DOWNTREND';
  if (dipInUp) return 'PULLBACK_UPTREND';
  if (trendingUp && !slopeDown) return 'TREND_UP';
  if (trendingDown && !slopeUp) return 'TREND_DOWN';
  if (reversal) return 'REVERSAL_CANDIDATE';
  if (slopeDown) {
    if (lastVel > 0.00025) return 'PULLBACK_DOWNTREND';
    return 'TREND_DOWN';
  }
  if (slopeUp) {
    if (lastVel < -0.00025) return 'PULLBACK_UPTREND';
    return 'TREND_UP';
  }
  if (inRange) return 'RANGE';
  if (previous !== 'UNKNOWN' && previous !== 'RANGE') return 'TRANSITION';
  return 'UNKNOWN';
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
    };
    books.set(key, b);
  } else if (displayName) {
    b.display_name = displayName;
  }
  return b;
}

function applyClassify(epic: string, b: Book): RegimeSnapshot {
  // Never stall live on UNKNOWN / COMPRESSION / TRANSITION
  const next = toLiveRegime(classifyRegime(b.bars, b.current));
  const now = new Date().toISOString();
  if (next !== b.current) {
    b.previous = b.current;
    b.current = next;
    b.since = now;
  }
  b.confidence = confidenceFrom(b.bars, b.current);
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
    // Same 10s bucket from another unit — replace, do not append (book pollution → wrong regime)
    if (last && last.open_time_ms === bar.open_time_ms) {
      if ((bar.ticks || 0) >= (last.ticks || 0)) b.bars[b.bars.length - 1] = bar;
      continue;
    }
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
  const next = toLiveRegime(normalizeRegime(regime));
  const now = new Date().toISOString();
  if (next !== b.current) {
    b.previous = b.current;
    b.current = next;
    b.since = now;
  }
  b.last_update = now;
  b.confidence = Math.max(b.confidence, 0.55);
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
