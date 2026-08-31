/** Regime classifier — real market states only (no UNKNOWN / TRANSITION). */
import type { TenSecBar } from './tenSecondOhlc.js';
import { bodyPct, rangePct } from './tenSecondOhlc.js';

export const REGIME_NAMES = [
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
] as const;

export type RegimeName = (typeof REGIME_NAMES)[number];

/** Legacy dead labels — never emit; always collapse to a real regime. */
const DEAD_REGIMES = new Set(['UNKNOWN', 'TRANSITION']);

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

/** Never returns UNKNOWN/TRANSITION — those are not market states. */
export function normalizeRegime(value: string | null | undefined): RegimeName {
  const v = String(value || '').trim().toUpperCase();
  if (DEAD_REGIMES.has(v) || !v) return 'RANGE';
  return isRegimeName(v) ? v : 'RANGE';
}

export function styleFromClassification(
  regime?: string | null,
  setupType?: string | null
): TradeStyle | null {
  const setup = String(setupType || '').trim().toUpperCase();
  if (setup === 'CONTINUATION' || setup === 'PULLBACK') return 'LONG';
  if (setup === 'BREAKOUT' || setup === 'FADE' || setup === 'REVERSAL') return 'SCALP';
  const raw = String(regime || '').trim().toUpperCase();
  if (!raw) return null; // no classification yet — do not invent from empty
  const r = normalizeRegime(regime);
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
  /** Candidate next regime awaiting confirmation bars */
  pending: RegimeName | null;
  pending_bars: number;
  /** Bars spent in current regime */
  hold_bars: number;
};

const MAX_BARS = 24;
/** Need this many agreeing 10s bars (~30s) before a normal regime flip */
const REGIME_CONFIRM_BARS = 3;
/** Only true expansion breaks confirm faster — NOT failed-break (that is minute-zone only) */
const FAST_REGIMES = new Set<RegimeName>([
  'BREAKOUT_UP',
  'BREAKOUT_DOWN',
  'REVERSAL_CANDIDATE',
]);
const books = new Map<string, Book>();

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function epicKey(epic: string): string {
  return String(epic || '').trim().toUpperCase();
}

/** Book key: epic alone (admin/pipeline) or scope::epic (per-robot / per-client). */
function bookKey(epic: string, scopeKey?: string | null): string {
  const e = epicKey(epic);
  const scope = String(scopeKey || '').trim();
  return scope ? `${scope}::${e}` : e;
}

function epicFromBookKey(key: string): string {
  const i = key.lastIndexOf('::');
  return i >= 0 ? key.slice(i + 2) : key;
}

/**
 * Classify from closed 10s OHLC.
 * Always returns a real operating regime — never UNKNOWN / TRANSITION.
 */
export function classifyRegime(bars: TenSecBar[], previous: RegimeName = 'RANGE'): RegimeName {
  const prev = normalizeRegime(previous);
  if (!bars.length || bars.length < 2) return 'RANGE';

  const window = bars.slice(-8);
  const last = window[window.length - 1]!;
  const prior = window.slice(0, -1);
  if (!prior.length) return 'RANGE';

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

  // Slightly looser than before so real Gold dumps/rallies register as TREND
  const trendingUp = persistence > 0.25 && lastVel > 0.00004;
  const trendingDown = persistence < -0.25 && lastVel < -0.00004;
  const compressed = lastRange < avgRange * 0.55 && lastRange < 0.00022;
  const expanding = lastRange > avgRange * 1.45 && lastRange >= 0.00025;
  const hi = Math.max(...prior.map((b) => b.high));
  const lo = Math.min(...prior.map((b) => b.low));
  const inRange = last.close <= hi && last.close >= lo;
  const breakoutUp = last.close > hi;
  const breakoutDown = last.close < lo;
  const reversal =
    (prev === 'TREND_UP' && lastVel < -0.0012 && lastRange > avgRange && !breakoutDown) ||
    (prev === 'TREND_DOWN' && lastVel > 0.0012 && lastRange > avgRange && !breakoutUp);

  // FAILED_BREAKOUT is NOT classified from 10s micro H/L (that was 1–3 bar fake).
  // Real failed breaks come from structureZones (multi-minute base + probe).
  // After a 10s "breakout" fades back inside → RANGE (wait for minute zones).
  if (prev === 'BREAKOUT_UP' && inRange && lastVel < 0) return 'RANGE';
  if (prev === 'BREAKOUT_DOWN' && inRange && lastVel > 0) return 'RANGE';
  if (compressed && inRange) return 'COMPRESSION';
  if (expanding && breakoutUp && (trendingUp || lastVel > 0)) return 'BREAKOUT_UP';
  if (expanding && breakoutDown && (trendingDown || lastVel < 0)) return 'BREAKOUT_DOWN';
  if (expanding) return 'EXPANSION';
  if (prev === 'TREND_UP' && lastVel < -0.00008 && persistence > 0.15) {
    return 'PULLBACK_UPTREND';
  }
  if (prev === 'TREND_DOWN' && lastVel > 0.00008 && persistence < -0.15) {
    return 'PULLBACK_DOWNTREND';
  }
  if (trendingUp) return 'TREND_UP';
  if (trendingDown) return 'TREND_DOWN';
  if (reversal) return 'REVERSAL_CANDIDATE';
  if (inRange) {
    // Stay in trend family on quiet in-range noise — do not flip to RANGE every bar
    if (prev === 'TREND_UP' || prev === 'PULLBACK_UPTREND') return 'PULLBACK_UPTREND';
    if (prev === 'TREND_DOWN' || prev === 'PULLBACK_DOWNTREND') return 'PULLBACK_DOWNTREND';
    return 'RANGE';
  }

  // Out of prior micro-range — prefer sticky / slow labels over single-bar TREND flips
  if (breakoutUp) return lastVel >= 0 ? 'BREAKOUT_UP' : 'REVERSAL_CANDIDATE';
  if (breakoutDown) return lastVel <= 0 ? 'BREAKOUT_DOWN' : 'REVERSAL_CANDIDATE';
  if (lastVel > 0.00012 && persistence > 0.15) return 'TREND_UP';
  if (lastVel < -0.00012 && persistence < -0.15) return 'TREND_DOWN';
  if (Math.abs(lastVel) >= 0.0001 || lastRange >= avgRange * 1.1) return 'EXPANSION';
  // Unclear → keep previous (hysteresis at classify level)
  return prev;
}

function confidenceFrom(bars: TenSecBar[], regime: RegimeName): number {
  if (bars.length < 2) return 0.2;
  const last = bars[bars.length - 1]!;
  const strength = Math.min(1, Math.abs(bodyPct(last)) / 0.0008 + rangePct(last) / 0.001);
  return Math.max(0.2, Math.min(0.95, 0.35 + strength * 0.5));
}

function toSnapshot(epic: string, b: Book): RegimeSnapshot {
  return {
    epic,
    display_name: b.display_name || epic,
    current: normalizeRegime(b.current),
    previous: normalizeRegime(b.previous),
    confidence: b.confidence,
    since: b.since,
    last_update: b.last_update,
    last_mid: b.last_mid,
    bar_count: b.bars.length,
  };
}

function ensureBook(epic: string, displayName?: string, scopeKey?: string | null): Book {
  const key = bookKey(epic, scopeKey);
  let b = books.get(key);
  if (!b) {
    const now = new Date().toISOString();
    b = {
      bars: [],
      current: 'RANGE',
      previous: 'RANGE',
      confidence: 0,
      since: now,
      display_name: displayName || epic,
      last_mid: null,
      last_update: now,
      pending: null,
      pending_bars: 0,
      hold_bars: 0,
    };
    books.set(key, b);
  } else if (displayName) {
    b.display_name = displayName;
  }
  // Migrate any book that still holds dead labels
  b.current = normalizeRegime(b.current as string);
  b.previous = normalizeRegime(b.previous as string);
  if (b.pending != null) b.pending = normalizeRegime(b.pending as string);
  if (b.pending_bars == null) b.pending_bars = 0;
  if (b.hold_bars == null) b.hold_bars = 0;
  return b;
}

function confirmNeed(raw: RegimeName): number {
  return FAST_REGIMES.has(raw) ? 1 : REGIME_CONFIRM_BARS;
}

function applyClassify(epic: string, b: Book, newBarCount: number): RegimeSnapshot {
  const now = new Date().toISOString();
  // Re-classify only when new bars arrived — never flicker on repeat polls
  if (newBarCount <= 0) {
    b.last_update = now;
    if (b.bars.length) b.last_mid = b.bars[b.bars.length - 1]!.close;
    b.confidence = confidenceFrom(b.bars, b.current);
    return toSnapshot(epic, b);
  }

  const raw = classifyRegime(b.bars, b.current);
  if (raw === b.current) {
    b.pending = null;
    b.pending_bars = 0;
    b.hold_bars += newBarCount;
  } else {
    if (b.pending === raw) {
      b.pending_bars += newBarCount;
    } else {
      b.pending = raw;
      b.pending_bars = newBarCount;
    }
    if (b.pending_bars >= confirmNeed(raw)) {
      b.previous = b.current;
      b.current = raw;
      b.pending = null;
      b.pending_bars = 0;
      b.hold_bars = newBarCount;
      b.since = now;
    }
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
  scopeKey?: string | null
): RegimeSnapshot {
  const b = ensureBook(epic, displayName, scopeKey);
  let added = 0;
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
    added += 1;
  }
  if (b.bars.length > MAX_BARS) b.bars.splice(0, b.bars.length - MAX_BARS);
  return applyClassify(epicKey(epic), b, added);
}

export function notePipelineRegime(
  epic: string,
  regime: string | null | undefined,
  displayName?: string
): RegimeSnapshot {
  // Pipeline annotations stay on an isolated book — never merge into a live robot's regime.
  const b = ensureBook(epic, displayName, 'pipeline');
  const next = normalizeRegime(regime);
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

export function currentRegime(
  epic: string | null | undefined,
  scopeKey?: string | null
): RegimeSnapshot | null {
  if (!epic) return null;
  const b = books.get(bookKey(epic, scopeKey));
  if (!b) return null;
  return toSnapshot(epicKey(epic), b);
}

export function listRegimeSnapshots(): RegimeSnapshot[] {
  return [...books.entries()].map(([key, b]) => toSnapshot(epicFromBookKey(key), b));
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
