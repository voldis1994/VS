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
  setupType?: string | null,
  side?: string | null
): TradeStyle | null {
  const setup = String(setupType || '').trim().toUpperCase();
  const dir = String(side || '').trim().toUpperCase();
  const r = String(regime || '').trim().toUpperCase();
  // Do not stamp LONG onto a SELL in an uptrend (or BUY in a downtrend).
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

/**
 * Directional lean of one 10s bar.
 * Relative-only thresholds (~0.00008) miss Gold bodies of 0.25–0.5pt
 * (0.35/4515 ≈ 0.000077) → every climb looked like RANGE forever.
 */
function leanSign(b: TenSecBar): number {
  const body = b.close - b.open;
  const abs = Math.max(Math.abs(b.open), 1e-9);
  const rel = body / abs;
  const absFloor = abs >= 1000 ? 0.12 : abs >= 100 ? 0.02 : abs >= 10 ? 0.002 : 0.00005;
  if (body > absFloor || rel > 0.00005) return 1;
  if (body < -absFloor || rel < -0.00005) return -1;
  return 0;
}

function epicKey(epic: string): string {
  return String(epic || '').trim().toUpperCase();
}

/**
 * Classify from closed 10s OHLC — same names as C++ RegimeEngine.
 *
 * Important: wick highs/lows must NOT trap a real climb/dump as RANGE forever.
 * Gold often prints 0.5–1.5pt wicks while closes grind — that is TREND, not RANGE.
 * Classic oscillation (no net, mixed persistence) stays RANGE.
 */
export function classifyRegime(bars: TenSecBar[], previous: RegimeName = 'UNKNOWN'): RegimeName {
  if (!bars.length || bars.length < 2) return 'UNKNOWN';

  const window = bars.slice(-8);
  const last = window[window.length - 1]!;
  const prior = window.slice(0, -1);
  if (!prior.length) return 'UNKNOWN';

  const ranges = window.map(rangePct);
  const priorRanges = prior.map(rangePct);
  const avgRange = Math.max(mean(priorRanges.length ? priorRanges : ranges), 1e-9);
  const lastLean = leanSign(last);
  const lastVel = bodyPct(last);
  const lastRange = rangePct(last);
  const persistWindow = window.slice(-6);
  const persistence = mean(persistWindow.map((b) => leanSign(b)));

  // Directional persistence — Gold-aware lean (absolute + relative).
  const trendingUp = persistence > 0.45 && lastLean > 0;
  const trendingDown = persistence < -0.45 && lastLean < 0;
  const compressed = lastRange < avgRange * 0.55 && lastRange < 0.00022;
  const expanding = lastRange > avgRange * 1.45 && lastRange >= 0.00025;
  // Wick envelope — true structure break / failed breakout.
  const hi = Math.max(...prior.map((b) => b.high));
  const lo = Math.min(...prior.map((b) => b.low));
  const inWickRange = last.close <= hi && last.close >= lo;
  // Body envelope — ignores wick traps that kept every Gold climb as RANGE.
  const bodyHi = Math.max(...prior.map((b) => Math.max(b.open, b.close)));
  const bodyLo = Math.min(...prior.map((b) => Math.min(b.open, b.close)));
  const inBodyRange = last.close <= bodyHi && last.close >= bodyLo;
  const breakoutUp = last.close > hi;
  const breakoutDown = last.close < lo;
  const first = window[0]!;
  const net = (last.close - first.open) / Math.max(Math.abs(first.open), 1e-9);
  // Oscillation = inside wick band + tiny net + no lean.
  const oscillating =
    inWickRange && Math.abs(net) < 0.00045 && Math.abs(persistence) < 0.35;
  // Directed grind: closes walking one way even if still under prior wick highs.
  const grindUp = net > 0.00045 && persistence >= 0.25;
  const grindDown = net < -0.00045 && persistence <= -0.25;
  const reversal =
    (previous === 'TREND_UP' && lastVel < -0.0012 && lastRange > avgRange && !breakoutDown) ||
    (previous === 'TREND_DOWN' && lastVel > 0.0012 && lastRange > avgRange && !breakoutUp);

  if (previous === 'BREAKOUT_UP' && inWickRange && lastLean < 0) return 'FAILED_BREAKOUT_UP';
  if (previous === 'BREAKOUT_DOWN' && inWickRange && lastLean > 0) return 'FAILED_BREAKOUT_DOWN';
  if (compressed && inWickRange) return 'COMPRESSION';
  if (expanding && breakoutUp && (trendingUp || lastLean > 0)) return 'BREAKOUT_UP';
  if (expanding && breakoutDown && (trendingDown || lastLean < 0)) return 'BREAKOUT_DOWN';
  if (expanding) return 'EXPANSION';
  if (previous === 'TREND_UP' && lastLean < 0 && persistence > 0.25 && !oscillating) {
    return 'PULLBACK_UPTREND';
  }
  if (previous === 'TREND_DOWN' && lastLean > 0 && persistence < -0.25 && !oscillating) {
    return 'PULLBACK_DOWNTREND';
  }
  if ((trendingUp || grindUp) && !oscillating) return 'TREND_UP';
  if ((trendingDown || grindDown) && !oscillating) return 'TREND_DOWN';
  if (reversal) return 'REVERSAL_CANDIDATE';

  // Classic range: real oscillation OR soft in-body chop — not wick-trapped climbs.
  if (oscillating) return 'RANGE';
  if (inBodyRange && Math.abs(persistence) < 0.35 && Math.abs(net) < 0.0005) return 'RANGE';
  if (inWickRange && Math.abs(persistence) < 0.2 && Math.abs(net) < 0.00035) return 'RANGE';

  // Strong directional break / continuation outside body band.
  if (net > 0.00055 && persistence > 0.2) return 'TREND_UP';
  if (net < -0.00055 && persistence < -0.2) return 'TREND_DOWN';
  if (previous !== 'UNKNOWN' && previous !== 'RANGE') return 'TRANSITION';
  if (window.length >= 4) return 'RANGE';
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
  const next = classifyRegime(b.bars, b.current);
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
