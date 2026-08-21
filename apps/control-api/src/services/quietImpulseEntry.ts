/**
 * Entry at move START via compression BOX → first break (matches chart “oval then drop”).
 *
 * #143: also micro-pause in a trend — continuous dumps never form a wide oval, so
 * a 3–4 bar pause then resume must still arm (otherwise forever WAIT).
 *
 * Modes (VS_ENTRY_MODE):
 *   box_break     — default
 *   quiet_impulse — old per-candle quiet path
 *   classic       — BASE #136 regime path
 */
import { bodyPct, isMoving10s, rangePct, type TenSecBar } from './tenSecondOhlc.js';
import type { RegimeEntry } from './entryFromRegime.js';

const BOX_BARS = 8;
const MIN_BOX_BARS = 5;
/** Whole zone height ≤ ~2.5pt on Gold ~4500 — oval case. */
const MAX_BOX_RANGE = 0.00055;
/** Shorter pause mid-trend (~3.6pt). */
const MICRO_BOX_BARS = 4;
const MICRO_MIN_BARS = 3;
const MICRO_MAX_BOX_RANGE = 0.00080;
const IMPULSE_BODY = 0.00022; // ~1pt
/** Allow a real first breakout candle; still skip extreme chase. */
const LATE_IMPULSE_BODY = 0.00115; // ~5.2pt Gold
/** Reject counter-trend breaks: ~1.6pt+ drift against the entry side. */
const ANTI_FADE_DRIFT = 0.00035;
/** Micro-pause must resume WITH the larger trend (~2pt+). */
const TREND_DRIFT = 0.00045;

/** Legacy quiet% path (#137) — kept for A/B via env. */
const QUIET_BODY = 0.00012;
const QUIET_RANGE = 0.00022;
const QUIET_LATE = 0.00080;
const QUIET_IMPULSE = 0.00022;
const QUIET_MIN = 3;

function isQuietBar(bar: TenSecBar): boolean {
  return Math.abs(bodyPct(bar)) <= QUIET_BODY && rangePct(bar) <= QUIET_RANGE;
}

export function quietBaseWindow(bars: TenSecBar[], lookback = 8): TenSecBar[] {
  if (bars.length < 2) return [];
  const prior = bars.slice(0, -1).slice(-lookback);
  const quiet: TenSecBar[] = [];
  for (let i = prior.length - 1; i >= 0; i--) {
    const b = prior[i]!;
    if (!isQuietBar(b)) break;
    quiet.unshift(b);
  }
  return quiet;
}

/** Prior bars that form the compression box (no per-candle quiet filter). */
export function compressionBox(bars: TenSecBar[], lookback = BOX_BARS): TenSecBar[] {
  if (bars.length < 2) return [];
  return bars.slice(0, -1).slice(-lookback);
}

/** Prior drift before impulse — blocks fade SELL into a buy move (and vice versa). */
export function priorDriftPct(bars: TenSecBar[], n = 8): number {
  const prior = bars.slice(0, -1).slice(-n);
  if (prior.length < 4) return 0;
  const a = prior[0]!.close;
  const b = prior[prior.length - 1]!.close;
  return (b - a) / Math.max(Math.abs(a), 1e-9);
}

/**
 * True when price has already sold off from a recent high (BUY into dump trap).
 * ~2.5pt off local high over last ~12 bars on Gold.
 */
export function isSellingOff(bars: TenSecBar[], n = 12): boolean {
  const prior = bars.slice(0, -1).slice(-n);
  if (prior.length < 5) return false;
  const hi = Math.max(...prior.map((b) => b.high));
  const last = prior[prior.length - 1]!.close;
  return (hi - last) / Math.max(Math.abs(last), 1e-9) >= 0.00055;
}

/** True when price has already rallied from a recent low (SELL into buy trap). */
export function isBuyingRally(bars: TenSecBar[], n = 12): boolean {
  const prior = bars.slice(0, -1).slice(-n);
  if (prior.length < 5) return false;
  const lo = Math.min(...prior.map((b) => b.low));
  const last = prior[prior.length - 1]!.close;
  return (last - lo) / Math.max(Math.abs(last), 1e-9) >= 0.00055;
}

function tryBoxBreak(
  bars: TenSecBar[],
  opts: {
    lookback: number;
    minBars: number;
    maxRange: number;
    tag: string;
    /** If set, break must align with this trend drift sign. */
    requireTrend?: boolean;
  }
): RegimeEntry | null {
  if (bars.length < opts.minBars + 1) return null;
  const impulse = bars[bars.length - 1]!;
  const box = compressionBox(bars, opts.lookback);
  if (box.length < opts.minBars) return null;

  const boxHigh = Math.max(...box.map((b) => b.high));
  const boxLow = Math.min(...box.map((b) => b.low));
  const mid = Math.max(Math.abs((boxHigh + boxLow) / 2), Math.abs(impulse.open), 1e-9);
  const boxRange = (boxHigh - boxLow) / mid;
  if (boxRange <= 0 || boxRange > opts.maxRange) return null;

  const bp = bodyPct(impulse);
  if (!isMoving10s(impulse) || Math.abs(bp) < IMPULSE_BODY) return null;
  if (Math.abs(bp) >= LATE_IMPULSE_BODY) return null;

  const drift = priorDriftPct(bars, Math.max(opts.lookback, 8));
  const longDrift = priorDriftPct(bars, 16);
  const candle = `10s O=${impulse.open.toFixed(2)} C=${impulse.close.toFixed(2)} body=${(
    bp * 100
  ).toFixed(3)}% · ${opts.tag}×${box.length} ${boxLow.toFixed(2)}–${boxHigh.toFixed(2)} (rng ${(
    boxRange * 100
  ).toFixed(3)}%) · drift ${(drift * 100).toFixed(3)}%`;

  if (bp > 0 && impulse.close > boxHigh && impulse.close > impulse.open) {
    // #145: never BUY into an active dump (micro-bounce long trap)
    if (drift <= -ANTI_FADE_DRIFT || longDrift <= -ANTI_FADE_DRIFT) return null;
    if (isSellingOff(bars)) return null;
    if (opts.requireTrend && drift < TREND_DRIFT) return null;
    return {
      direction: 'BUY',
      setup: 'BREAKOUT',
      reason: `BOX→BREAK long · ${candle}`,
    };
  }

  if (bp < 0 && impulse.close < boxLow && impulse.close < impulse.open) {
    if (drift >= ANTI_FADE_DRIFT || longDrift >= ANTI_FADE_DRIFT) return null;
    if (isBuyingRally(bars)) return null;
    if (opts.requireTrend && drift > -TREND_DRIFT) return null;
    return {
      direction: 'SELL',
      setup: 'BREAKOUT',
      reason: `BOX→BREAK short · ${candle}`,
    };
  }

  return null;
}

/**
 * Tight recent range (box) then first close outside the box.
 * Falls back to micro-pause resume in an established dump/rally (#143).
 */
export function decideEntryFromBoxBreak(bars: TenSecBar[]): RegimeEntry | null {
  const oval = tryBoxBreak(bars, {
    lookback: BOX_BARS,
    minBars: MIN_BOX_BARS,
    maxRange: MAX_BOX_RANGE,
    tag: 'box',
  });
  if (oval) return oval;

  // Continuous dump/rally: no wide oval — catch short pause then resume with trend
  return tryBoxBreak(bars, {
    lookback: MICRO_BOX_BARS,
    minBars: MICRO_MIN_BARS,
    maxRange: MICRO_MAX_BOX_RANGE,
    tag: 'micro',
    requireTrend: true,
  });
}

export function decideEntryFromQuietImpulse(bars: TenSecBar[]): RegimeEntry | null {
  if (bars.length < QUIET_MIN + 1) return null;
  const impulse = bars[bars.length - 1]!;
  const base = quietBaseWindow(bars, 8);
  if (base.length < QUIET_MIN) return null;
  if (Math.abs(bodyPct(impulse)) < QUIET_IMPULSE || !isMoving10s(impulse)) return null;

  const bp = bodyPct(impulse);
  if (Math.abs(bp) >= QUIET_LATE) return null;

  const baseHigh = Math.max(...base.map((b) => b.high));
  const baseLow = Math.min(...base.map((b) => b.low));
  const baseMid = base.reduce((s, b) => s + b.close, 0) / Math.max(base.length, 1);
  const candle = `10s O=${impulse.open.toFixed(2)} C=${impulse.close.toFixed(2)} body=${(
    bp * 100
  ).toFixed(3)}% · quiet×${base.length} @${baseMid.toFixed(2)}`;

  if (bp > 0 && impulse.close > baseHigh && impulse.close > impulse.open) {
    return { direction: 'BUY', setup: 'BREAKOUT', reason: `QUIET→IMPULSE long · ${candle}` };
  }
  if (bp < 0 && impulse.close < baseLow && impulse.close < impulse.open) {
    return { direction: 'SELL', setup: 'BREAKOUT', reason: `QUIET→IMPULSE short · ${candle}` };
  }
  return null;
}

export type EntryMode = 'box_break' | 'quiet_impulse' | 'classic';

export function resolveEntryMode(raw?: string | null): EntryMode {
  const v = String(raw || process.env.VS_ENTRY_MODE || 'box_break')
    .trim()
    .toLowerCase();
  if (v === 'classic') return 'classic';
  if (v === 'quiet_impulse' || v === 'quiet') return 'quiet_impulse';
  return 'box_break';
}

/** Wait after any close before next entry. Default 90s (#143 — was 150s forever-WAIT feel). */
export function resolvePostExitCooldownMs(raw?: string | null): number {
  const source = raw === undefined ? process.env.VS_POST_EXIT_COOLDOWN_MS : raw;
  if (source == null || String(source).trim() === '') return 90_000;
  const n = Number(source);
  if (!Number.isFinite(n) || n < 0) return 90_000;
  return Math.min(Math.max(n, 0), 600_000);
}
