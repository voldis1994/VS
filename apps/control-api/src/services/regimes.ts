/** Original spec §13 — all regime names. Regime is a market-state classifier, not an entry. */
import type { TenSecBar } from './tenSecondOhlc.js';
import { bodyPct, rangePct } from './tenSecondOhlc.js';
import {
  CLEAR_BREAK_FRAC,
  COMPRESS_ABS,
  COMPRESS_AVG_MULT,
  EXPAND_ABS,
  EXPAND_AVG_MULT,
  MOVE,
  NEAR_ZONE_MID,
  PERSIST_ENTER,
  PERSIST_PULLBACK,
  PERSIST_STAY,
  PULLBACK,
  REVERSAL,
  TREND_ENTER,
  TREND_STAY,
} from './regimeBands.js';

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
  /** Bars spent in current regime (10s each) — dwell / anti-flicker */
  bars_in_current: number;
  /** Candidate waiting for confirmation bars */
  pending: RegimeName | null;
  pending_count: number;
};

const MAX_BARS = 216;
const books = new Map<string, Book>();
/** Structure zone ≈ 30 minutes of 10s bars (180 × 10s) — not last micro-candle only */
const ZONE_BARS = 180;
/** Momentum window (still short — direction of the last ~80s inside the 30m zone) */
const MOM_BARS = 8;
/** Stay in a regime ≥50s before soft switches — room between % bands to settle */
const MIN_DWELL_BARS = 5;
/** Cross-family soft switches need this many agreeing candidates after dwell */
const CONFIRM_BARS = 3;

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function epicKey(epic: string): string {
  return String(epic || '').trim().toUpperCase();
}

type RegimeFamily = 'UP' | 'DOWN' | 'CHOP' | 'VOL' | 'BRK_UP' | 'BRK_DOWN' | 'REV' | 'UNK';

function regimeFamily(r: RegimeName): RegimeFamily {
  switch (r) {
    case 'TREND_UP':
    case 'PULLBACK_UPTREND':
      return 'UP';
    case 'TREND_DOWN':
    case 'PULLBACK_DOWNTREND':
      return 'DOWN';
    case 'RANGE':
    case 'COMPRESSION':
    case 'TRANSITION':
      return 'CHOP';
    case 'EXPANSION':
      return 'VOL';
    case 'BREAKOUT_UP':
    case 'FAILED_BREAKOUT_UP':
      return 'BRK_UP';
    case 'BREAKOUT_DOWN':
    case 'FAILED_BREAKOUT_DOWN':
      return 'BRK_DOWN';
    case 'REVERSAL_CANDIDATE':
      return 'REV';
    default:
      return 'UNK';
  }
}

/** Hard flips allowed before dwell completes (structure break / violent reverse). */
function isStrongSwitch(from: RegimeName, to: RegimeName): boolean {
  if (from === 'UNKNOWN' || from === 'TRANSITION') return true;
  if (to === 'REVERSAL_CANDIDATE') return true;
  if (to === 'FAILED_BREAKOUT_UP' || to === 'FAILED_BREAKOUT_DOWN') return true;
  if (to === 'BREAKOUT_UP' || to === 'BREAKOUT_DOWN') return true;
  const a = regimeFamily(from);
  const b = regimeFamily(to);
  // Opposite trend family
  if ((a === 'UP' || a === 'BRK_UP') && (b === 'DOWN' || b === 'BRK_DOWN')) return true;
  if ((a === 'DOWN' || a === 'BRK_DOWN') && (b === 'UP' || b === 'BRK_UP')) return true;
  return false;
}

/**
 * Classify from closed 10s OHLC using a 30m structure zone + short momentum.
 * Raw candidate only — live path must run through stabilizeRegime (dwell + confirm).
 * Enter vs stay thresholds keep hysteresis so borderline % ticks do not flip regimes.
 */
export function classifyRegime(bars: TenSecBar[], previous: RegimeName = 'UNKNOWN'): RegimeName {
  if (!bars.length || bars.length < 2) return 'UNKNOWN';

  const zone = bars.slice(-ZONE_BARS);
  const mom = bars.slice(-MOM_BARS);
  const last = mom[mom.length - 1]!;
  const zonePrior = zone.slice(0, -1);
  const momPrior = mom.slice(0, -1);
  if (!zonePrior.length || !momPrior.length) return 'UNKNOWN';

  const velocities = mom.map(bodyPct);
  const ranges = mom.map(rangePct);
  const priorRanges = momPrior.map(rangePct);
  const avgRange = Math.max(mean(priorRanges.length ? priorRanges : ranges), 1e-9);
  const lastVel = bodyPct(last);
  const lastRange = rangePct(last);
  const persistWindow = velocities.slice(-6);
  const persistence = mean(
    persistWindow.map((v) => (v > MOVE ? 1 : v < -MOVE ? -1 : 0))
  );

  const inUpFamily = previous === 'TREND_UP' || previous === 'PULLBACK_UPTREND';
  const inDownFamily = previous === 'TREND_DOWN' || previous === 'PULLBACK_DOWNTREND';
  // Hysteresis: already-in-trend stays on TREND_STAY; fresh enter needs TREND_ENTER (> stay)
  const trendingUp = inUpFamily
    ? persistence > PERSIST_STAY && lastVel > TREND_STAY
    : persistence > PERSIST_ENTER && lastVel > TREND_ENTER;
  const trendingDown = inDownFamily
    ? persistence < -PERSIST_STAY && lastVel < -TREND_STAY
    : persistence < -PERSIST_ENTER && lastVel < -TREND_ENTER;
  const compressed =
    lastRange < avgRange * COMPRESS_AVG_MULT && lastRange < COMPRESS_ABS;
  const expanding =
    lastRange > avgRange * EXPAND_AVG_MULT && lastRange >= EXPAND_ABS;

  // Zone highs/lows — multi-minute structure, not last micro-candle chop
  const hi = Math.max(...zonePrior.map((b) => b.high));
  const lo = Math.min(...zonePrior.map((b) => b.low));
  const zoneMid = (hi + lo) / 2;
  const zoneWidth = Math.max(hi - lo, 1e-9);
  const inRange = last.close <= hi && last.close >= lo;
  const nearZoneMid = Math.abs(last.close - zoneMid) / zoneWidth < NEAR_ZONE_MID;
  const breakoutUp = last.close > hi;
  const breakoutDown = last.close < lo;
  /** Quiet pierce of a chop zone — not a continuation of an existing trend */
  const fromChop =
    previous === 'RANGE' ||
    previous === 'COMPRESSION' ||
    previous === 'TRANSITION' ||
    previous === 'UNKNOWN' ||
    previous === 'EXPANSION' ||
    previous === 'REVERSAL_CANDIDATE';
  const clearBreakUp =
    fromChop && breakoutUp && (last.close - hi) / zoneWidth >= CLEAR_BREAK_FRAC;
  const clearBreakDown =
    fromChop && breakoutDown && (lo - last.close) / zoneWidth >= CLEAR_BREAK_FRAC;
  const reversal =
    (previous === 'TREND_UP' &&
      lastVel < -REVERSAL &&
      lastRange > avgRange &&
      !breakoutDown) ||
    (previous === 'TREND_DOWN' &&
      lastVel > REVERSAL &&
      lastRange > avgRange &&
      !breakoutUp);

  if (previous === 'BREAKOUT_UP' && inRange && lastVel < -MOVE) return 'FAILED_BREAKOUT_UP';
  if (previous === 'BREAKOUT_DOWN' && inRange && lastVel > MOVE) return 'FAILED_BREAKOUT_DOWN';
  // Expansion OR clear pierce out of chop — body must clear TREND_ENTER
  if ((expanding || clearBreakUp) && breakoutUp && (trendingUp || lastVel > TREND_ENTER))
    return 'BREAKOUT_UP';
  if (
    (expanding || clearBreakDown) &&
    breakoutDown &&
    (trendingDown || lastVel < -TREND_ENTER)
  )
    return 'BREAKOUT_DOWN';
  if (expanding) return 'EXPANSION';

  // Pullbacks: against-body ≥ PULLBACK (> TREND_ENTER) so soft noise ≠ pullback
  if (
    previous === 'TREND_UP' &&
    lastVel <= -PULLBACK &&
    persistence > PERSIST_PULLBACK &&
    inRange
  ) {
    return 'PULLBACK_UPTREND';
  }
  if (
    previous === 'TREND_DOWN' &&
    lastVel >= PULLBACK &&
    persistence < -PERSIST_PULLBACK &&
    inRange
  ) {
    return 'PULLBACK_DOWNTREND';
  }
  // Resume trend from pullback only on enter-band strength
  if (
    previous === 'PULLBACK_UPTREND' &&
    persistence > PERSIST_ENTER &&
    lastVel > TREND_ENTER
  )
    return 'TREND_UP';
  if (
    previous === 'PULLBACK_DOWNTREND' &&
    persistence < -PERSIST_ENTER &&
    lastVel < -TREND_ENTER
  )
    return 'TREND_DOWN';

  if (trendingUp) return 'TREND_UP';
  if (trendingDown) return 'TREND_DOWN';
  if (reversal) return 'REVERSAL_CANDIDATE';

  // Compression only in the tight absolute band near mid — dead zone above → RANGE
  if (compressed && inRange && nearZoneMid) return 'COMPRESSION';
  if (inRange) return 'RANGE';

  // Sticky prior instead of dead TRANSITION
  if (previous !== 'UNKNOWN' && previous !== 'TRANSITION') return previous;
  return 'UNKNOWN';
}

/**
 * Anti-flicker without freeze:
 * - Soft noise before dwell stays on current regime
 * - Pending candidate is NOT cleared on reject (so confirm survives dwell)
 * - After dwell, 2 agreeing bars switch; same-family / strong = 1 bar after dwell
 * - Strong (opposite family / breakout) may switch before dwell completes
 * - Same-family (TREND↔PULLBACK) no longer bypasses dwell — that caused 10s recipe flicker
 */
export function stabilizeRegime(
  book: {
    current: RegimeName;
    previous: RegimeName;
    bars_in_current: number;
    pending: RegimeName | null;
    pending_count: number;
    since: string;
  },
  candidate: RegimeName,
  nowIso = new Date().toISOString()
): RegimeName {
  if (candidate === book.current) {
    book.bars_in_current += 1;
    book.pending = null;
    book.pending_count = 0;
    return book.current;
  }

  // Always accumulate the pending candidate (even during dwell)
  if (book.pending === candidate) book.pending_count += 1;
  else {
    book.pending = candidate;
    book.pending_count = 1;
  }

  const sameFamily = regimeFamily(candidate) === regimeFamily(book.current);
  const strong = isStrongSwitch(book.current, candidate);
  const dwellOk =
    book.current === 'UNKNOWN' || book.bars_in_current >= MIN_DWELL_BARS;
  const need = sameFamily || strong ? 1 : CONFIRM_BARS;
  // sameFamily must still wait for dwell — only strong structure breaks skip it
  const canSwitch = (dwellOk || strong) && book.pending_count >= need;

  if (canSwitch) {
    book.previous = book.current;
    book.current = candidate;
    book.bars_in_current = 1;
    book.pending = null;
    book.pending_count = 0;
    book.since = nowIso;
    return book.current;
  }

  book.bars_in_current += 1;
  return book.current;
}

/**
 * Book storage key.
 * - Unscoped (`GOLD`) — optional market aggregate / pipeline stamp
 * - Scoped (`a12::GOLD`) — per broker account so multi-client same epic never mixes
 */
export function regimeBookKey(epic: string, accountId?: number | string | null): string {
  const e = epicKey(epic);
  if (accountId === undefined || accountId === null || accountId === '') return e;
  const n = Number(accountId);
  if (Number.isFinite(n) && n > 0) return `a${n}::${e}`;
  return `${String(accountId).trim()}::${e}`;
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

function ensureBook(
  epic: string,
  displayName?: string,
  accountId?: number | string | null
): Book {
  const key = regimeBookKey(epic, accountId);
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
      bars_in_current: 0,
      pending: null,
      pending_count: 0,
    };
    books.set(key, b);
  } else if (displayName) {
    b.display_name = displayName;
  }
  return b;
}

function applyClassify(epic: string, b: Book): RegimeSnapshot {
  const candidate = classifyRegime(b.bars, b.current);
  const now = new Date().toISOString();
  stabilizeRegime(b, candidate, now);
  b.confidence = confidenceFrom(b.bars, b.current);
  b.last_update = now;
  if (b.bars.length) b.last_mid = b.bars[b.bars.length - 1]!.close;
  return toSnapshot(epicKey(epic), b);
}

export function observeClosedBars(
  epic: string,
  bars: TenSecBar[],
  displayName?: string,
  accountId?: number | string | null
): RegimeSnapshot {
  const b = ensureBook(epic, displayName, accountId);
  let snap: RegimeSnapshot | null = null;
  for (const bar of bars) {
    if (!bar || !Number.isFinite(bar.close)) continue;
    const last = b.bars[b.bars.length - 1];
    const same =
      last &&
      Math.abs(last.open - bar.open) < 1e-9 &&
      Math.abs(last.close - bar.close) < 1e-9 &&
      Math.abs(last.high - bar.high) < 1e-9 &&
      Math.abs(last.low - bar.low) < 1e-9;
    if (same) continue;
    b.bars.push(bar);
    if (b.bars.length > MAX_BARS) b.bars.splice(0, b.bars.length - MAX_BARS);
    // Per-bar stabilize — batch classify once would skip dwell/confirm accumulation
    snap = applyClassify(epic, b);
  }
  return snap ?? toSnapshot(epicKey(epic), b);
}

/**
 * Pipeline stamp:
 * - Unscoped (market board): show pipeline regime for display
 * - Account-scoped (robot desk books): advisory pending only — NEVER switch.
 *   Robot OHLC observeClosedBars owns sticky dwell/confirm; strong flips here
 *   were wiping TREND_UP → TREND_DOWN on a single intent stamp.
 */
export function notePipelineRegime(
  epic: string,
  regime: string | null | undefined,
  displayName?: string,
  accountId?: number | string | null
): RegimeSnapshot {
  const b = ensureBook(epic, displayName, accountId);
  const next = normalizeRegime(regime);
  const now = new Date().toISOString();
  const scoped =
    accountId !== undefined && accountId !== null && String(accountId).trim() !== '';

  if (scoped) {
    if (next === b.current) {
      b.bars_in_current += 1;
      b.pending = null;
      b.pending_count = 0;
    } else if (next !== 'UNKNOWN') {
      if (b.pending === next) b.pending_count += 1;
      else {
        b.pending = next;
        b.pending_count = 1;
      }
    }
  } else if (next !== b.current) {
    b.previous = b.current;
    b.current = next;
    b.since = now;
    b.bars_in_current = 1;
    b.pending = null;
    b.pending_count = 0;
  } else {
    b.bars_in_current += 1;
  }
  b.last_update = now;
  if (next !== 'UNKNOWN') b.confidence = Math.max(b.confidence, 0.55);
  return toSnapshot(epicKey(epic), b);
}

export function currentRegime(
  epic: string | null | undefined,
  accountId?: number | string | null
): RegimeSnapshot | null {
  if (!epic) return null;
  const b = books.get(regimeBookKey(epic, accountId));
  if (!b) return null;
  return toSnapshot(epicKey(epic), b);
}

export function listRegimeSnapshots(): RegimeSnapshot[] {
  // Market board: unscoped books only (no a{id}:: prefix)
  return [...books.entries()]
    .filter(([k]) => !k.includes('::'))
    .map(([epic, b]) => toSnapshot(epic, b));
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
