/**
 * One entry rule on 5m:
 *   market direction (short slope, else regime) → same side
 *   live bar = soft timing only
 *
 * No filter pile: no swing-high block stack, no late-chase, no EXPANSION guess.
 * SKIP only: quiet chop regimes, no clear direction, flat live.
 */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { bodyPct, isMoving5m, rangePct, type TenSecBar } from './tenSecondOhlc.js';

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK' | 'BREAKOUT' | 'FADE' | 'REVERSAL';
  reason: string;
};

/** Soft live timing — ~2pt or soft range. */
function softLive(bar: TenSecBar): boolean {
  const pts = Math.abs(bar.close - bar.open);
  return pts >= 2 || rangePct(bar) >= 0.0006 || isMoving5m(bar);
}

function isGreen(bar: TenSecBar): boolean {
  return bar.close > bar.open;
}

function isRed(bar: TenSecBar): boolean {
  return bar.close < bar.open;
}

function describe(bar: TenSecBar): string {
  return `5m O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bodyPct(bar) * 100).toFixed(3)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
}

/** Net over lookback bars. Clear dir at ~0.18% ≈ 8pt Gold. */
export function recentImpulse(
  bars: TenSecBar[] | null | undefined,
  lookback = 3
): { dir: 'UP' | 'DOWN' | null; netPct: number; netPts: number } {
  if (!bars?.length) return { dir: null, netPct: 0, netPts: 0 };
  const window = bars.slice(-Math.max(lookback, 2));
  if (window.length < 2) return { dir: null, netPct: 0, netPts: 0 };
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const netPts = last.close - first.open;
  const mid = Math.max(Math.abs(first.open), 1e-9);
  const netPct = netPts / mid;
  if (netPct >= 0.0018) return { dir: 'UP', netPct, netPts };
  if (netPct <= -0.0018) return { dir: 'DOWN', netPct, netPts };
  return { dir: null, netPct, netPts };
}

function withLive(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): TenSecBar[] {
  const all = [...(bars ?? [])];
  if (liveBar && Number.isFinite(liveBar.close)) {
    const last = all[all.length - 1];
    if (!last || last.open_time_ms !== liveBar.open_time_ms) all.push(liveBar);
    else all[all.length - 1] = liveBar;
  }
  return all;
}

/** Short ~30m net including live bar. */
export function shortNetMove(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { dir: 'UP' | 'DOWN' | null; netPct: number; netPts: number } {
  return recentImpulse(withLive(bars, liveBar), 6);
}

/** Kept for older tests / callers — thin wrappers around short net. */
export function selloffFromSwingHigh(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { dumpPts: number; dumpPct: number } {
  const s = shortNetMove(bars, liveBar);
  if (s.netPct >= 0) return { dumpPts: 0, dumpPct: 0 };
  return { dumpPts: -s.netPts, dumpPct: -s.netPct };
}

export function rallyFromSwingLow(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { rallyPts: number; rallyPct: number } {
  const s = shortNetMove(bars, liveBar);
  if (s.netPct <= 0) return { rallyPts: 0, rallyPct: 0 };
  return { rallyPts: s.netPts, rallyPct: s.netPct };
}

export function signalBarTooLate(_bar: TenSecBar): boolean {
  // Removed — fat-candle / late-bar gate was part of the filter pile.
  return false;
}

/**
 * ONE alignment rule: do not trade against a clear short-window direction.
 * No swing-high stack, no second impulse check.
 */
export function allowEntryAgainstImpulse(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { ok: boolean; reason: string } {
  const short = shortNetMove(bars, liveBar);
  if (!short.dir) return { ok: true, reason: 'no clear short direction' };
  if (direction === 'BUY' && short.dir === 'DOWN') {
    return {
      ok: false,
      reason: `vs market · short DOWN ${short.netPts.toFixed(1)}pt — no BUY`,
    };
  }
  if (direction === 'SELL' && short.dir === 'UP') {
    return {
      ok: false,
      reason: `vs market · short UP ${short.netPts.toFixed(1)}pt — no SELL`,
    };
  }
  return { ok: true, reason: `with market ${short.dir}` };
}

/** Late-chase removed from live path. */
export function lateChaseAppliesToSetup(
  _setup: RegimeEntry['setup'],
  _regime?: string | null
): boolean {
  return false;
}

function regimeBias(r: RegimeName): 'BUY' | 'SELL' | null {
  if (r === 'TREND_UP' || r === 'PULLBACK_UPTREND' || r === 'BREAKOUT_UP') return 'BUY';
  if (r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND' || r === 'BREAKOUT_DOWN') return 'SELL';
  return null; // EXPANSION / other → use short slope only
}

/** Direction: short slope wins; else regime bias. */
export function marketDirection(
  regime?: string | null,
  closedBars?: TenSecBar[] | null,
  liveBar?: TenSecBar | null
): 'BUY' | 'SELL' | null {
  const short = shortNetMove(closedBars, liveBar);
  if (short.dir === 'UP') return 'BUY';
  if (short.dir === 'DOWN') return 'SELL';
  return regimeBias(normalizeRegime(regime));
}

export function explainNoEntry(
  bar: TenSecBar,
  regime?: string | null,
  closedBars?: TenSecBar[] | null
): string {
  const r = normalizeRegime(regime);
  const short = shortNetMove(closedBars, bar);
  const dir = marketDirection(regime, closedBars, bar);
  const bits = `body=${(bodyPct(bar) * 100).toFixed(2)}% short=${short.dir ?? 'flat'}/${short.netPts.toFixed(1)}pt`;
  if (!softLive(bar)) return `wait soft live · ${bits}`;
  if (!dir) return `no market direction · regime ${r} · ${bits}`;
  return `no timing for ${dir} · ${bits}`;
}

export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null,
  closedBars?: TenSecBar[] | null
): RegimeEntry | null {
  const r: RegimeName = normalizeRegime(regime);
  const candle = describe(bar);

  if (
    r === 'UNKNOWN' ||
    r === 'TRANSITION' ||
    r === 'COMPRESSION' ||
    r === 'RANGE' ||
    r === 'REVERSAL_CANDIDATE' ||
    r === 'FAILED_BREAKOUT_UP' ||
    r === 'FAILED_BREAKOUT_DOWN'
  ) {
    return null;
  }

  if (!softLive(bar)) return null;

  const dir = marketDirection(regime, closedBars, bar);
  if (!dir) return null;

  // Soft timing with the market — continuation preferred; mild pullback OK
  if (dir === 'BUY') {
    if (isGreen(bar)) {
      return {
        direction: 'BUY',
        setup: r.includes('BREAKOUT') ? 'BREAKOUT' : 'CONTINUATION',
        reason: `${r} with market BUY · ${candle}`,
      };
    }
    if (isRed(bar)) {
      return {
        direction: 'BUY',
        setup: 'PULLBACK',
        reason: `${r} dip-buy with UP market · ${candle}`,
      };
    }
    return null;
  }

  if (isRed(bar)) {
    return {
      direction: 'SELL',
      setup: r.includes('BREAKOUT') ? 'BREAKOUT' : 'CONTINUATION',
      reason: `${r} with market SELL · ${candle}`,
    };
  }
  if (isGreen(bar)) {
    return {
      direction: 'SELL',
      setup: 'PULLBACK',
      reason: `${r} rally-sell with DOWN market · ${candle}`,
    };
  }
  return null;
}
