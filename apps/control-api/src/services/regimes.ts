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

const MAX_BARS = 24;
const books = new Map<string, Book>();

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function epicKey(epic: string): string {
  return String(epic || '').trim().toUpperCase();
}

/** Book key: per-robot when scope given — two Gold clients must not share one regime brain. */
function bookKey(epic: string, scope?: string | null): string {
  const e = epicKey(epic);
  const s = String(scope || '').trim();
  return s ? `${e}::${s}` : e;
}

/**
 * Classify from closed 10s OHLC — same names as C++ RegimeEngine.
 * Failed-breakout variants are live here (reserved in C++).
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
    persistWindow.map((v) => (v > 0.00008 ? 1 : v < -0.00008 ? -1 : 0))
  );

  const trendingUp = persistence > 0.35 && lastVel > 0.00005;
  const trendingDown = persistence < -0.35 && lastVel < -0.00005;
  const compressed = lastRange < avgRange * 0.55 && lastRange < 0.00022;
  const expanding = lastRange > avgRange * 1.45 && lastRange >= 0.00025;
  const hi = Math.max(...prior.map((b) => b.high));
  const lo = Math.min(...prior.map((b) => b.low));
  const inRange = last.close <= hi && last.close >= lo;
  const breakoutUp = last.close > hi;
  const breakoutDown = last.close < lo;
  const reversal =
    (previous === 'TREND_UP' && lastVel < -0.0012 && lastRange > avgRange && !breakoutDown) ||
    (previous === 'TREND_DOWN' && lastVel > 0.0012 && lastRange > avgRange && !breakoutUp);

  if (previous === 'BREAKOUT_UP' && inRange && lastVel < 0) return 'FAILED_BREAKOUT_UP';
  if (previous === 'BREAKOUT_DOWN' && inRange && lastVel > 0) return 'FAILED_BREAKOUT_DOWN';
  if (compressed && inRange) return 'COMPRESSION';
  if (expanding && breakoutUp && (trendingUp || lastVel > 0)) return 'BREAKOUT_UP';
  if (expanding && breakoutDown && (trendingDown || lastVel < 0)) return 'BREAKOUT_DOWN';
  if (expanding) return 'EXPANSION';
  if (previous === 'TREND_UP' && lastVel < -0.00008 && persistence > 0.15) {
    return 'PULLBACK_UPTREND';
  }
  if (previous === 'TREND_DOWN' && lastVel > 0.00008 && persistence < -0.15) {
    return 'PULLBACK_DOWNTREND';
  }
  if (trendingUp) return 'TREND_UP';
  if (trendingDown) return 'TREND_DOWN';
  if (reversal) return 'REVERSAL_CANDIDATE';
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

function ensureBook(epic: string, displayName?: string, scope?: string | null): Book {
  const key = bookKey(epic, scope);
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

/** Live trading: only these regimes exist. Everything else is OFF → UNKNOWN. */
export const LIVE_REGIME_NAMES = [
  'UNKNOWN',
  'COMPRESSION',
  'BREAKOUT_UP',
  'BREAKOUT_DOWN',
] as const;

export type LiveRegimeName = (typeof LIVE_REGIME_NAMES)[number];

export function toLiveRegime(regime: RegimeName): RegimeName {
  if (
    regime === 'BREAKOUT_UP' ||
    regime === 'BREAKOUT_DOWN' ||
    regime === 'COMPRESSION' ||
    regime === 'UNKNOWN'
  ) {
    return regime;
  }
  return 'UNKNOWN';
}

function applyClassify(epic: string, b: Book): RegimeSnapshot {
  // Full classifier still runs internally; live book only keeps breakout (+ compression wait)
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
  displayName?: string,
  scope?: string | null
): RegimeSnapshot {
  const b = ensureBook(epic, displayName, scope);
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
  return applyClassify(epicKey(epic), b);
}

export function notePipelineRegime(
  epic: string,
  regime: string | null | undefined,
  displayName?: string,
  scope?: string | null
): RegimeSnapshot {
  const b = ensureBook(epic, displayName, scope);
  const next = normalizeRegime(regime);
  const now = new Date().toISOString();
  if (next !== b.current) {
    b.previous = b.current;
    b.current = next;
    b.since = now;
  }
  b.last_update = now;
  if (next !== 'UNKNOWN') b.confidence = Math.max(b.confidence, 0.55);
  b.current = toLiveRegime(next);
  return toSnapshot(epicKey(epic), b);
}

export function currentRegime(
  epic: string | null | undefined,
  scope?: string | null
): RegimeSnapshot | null {
  if (!epic) return null;
  const b = books.get(bookKey(epic, scope));
  if (!b) return null;
  return toSnapshot(epicKey(epic), b);
}

export function listRegimeSnapshots(): RegimeSnapshot[] {
  return [...books.entries()].map(([key, b]) => {
    const epic = key.includes('::') ? key.slice(0, key.indexOf('::')) : key;
    return toSnapshot(epic, b);
  });
}

export function regimeCatalog() {
  return REGIME_NAMES.map((name) => ({
    name,
    kind: styleFromClassification(name) || 'NONE',
  }));
}

/** Test helper — wipe all books. */
export function resetRegimeBook(): void {
  books.clear();
}

/** Clear one robot's regime book on start — no stale bars from prior run. */
export function clearRegimeBookFor(epic: string, scope: string): void {
  const key = bookKey(epic, scope);
  books.delete(key);
}
