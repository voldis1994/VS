/**
 * Regime-led entry on 5m.
 * Market type (TREND / EXPANSION / BREAKOUT) is the thesis.
 * Live bar is only a light timing trigger — do NOT wait for a fat 4–6pt
 * candle that arrives after the move is spent.
 * SKIP: RANGE chop, FADE, REVERSAL, quiet doji.
 */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { bodyPct, isMoving5m, rangePct, type TenSecBar } from './tenSecondOhlc.js';

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK' | 'BREAKOUT' | 'FADE' | 'REVERSAL';
  reason: string;
};

/** Soft live timing once regime is known — ~2pt or soft range (not 4–6pt). */
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

/** Clear pullback body ~0.10% ≈ 4.6pt Gold (optional stronger pullback tag). */
const PULLBACK_BODY_PCT = 0.001;

function dip(bar: TenSecBar): boolean {
  return bodyPct(bar) <= -PULLBACK_BODY_PCT || (isRed(bar) && softLive(bar));
}

function rally(bar: TenSecBar): boolean {
  return bodyPct(bar) >= PULLBACK_BODY_PCT || (isGreen(bar) && softLive(bar));
}

function describe(bar: TenSecBar): string {
  return `5m O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bodyPct(bar) * 100).toFixed(3)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
}

/** Single-bar exhaustion — ~0.45% ≈ 21pt Gold. */
const LATE_SIGNAL_BODY_PCT = 0.0045;

export function signalBarTooLate(bar: TenSecBar): boolean {
  return Math.abs(bodyPct(bar)) >= LATE_SIGNAL_BODY_PCT;
}

/** Impulse over ~3×5m. ~0.25% ≈ 11.5pt Gold. */
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
  if (netPct >= 0.0025) return { dir: 'UP', netPct, netPts };
  if (netPct <= -0.0025) return { dir: 'DOWN', netPct, netPts };
  return { dir: null, netPct, netPts };
}

/** Short ~30m net including optional live bar — blocks BUY into an active dump. */
export function shortNetMove(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { dir: 'UP' | 'DOWN' | null; netPct: number; netPts: number } {
  const all = [...(bars ?? [])];
  if (liveBar && Number.isFinite(liveBar.close)) {
    const last = all[all.length - 1];
    if (!last || last.open_time_ms !== liveBar.open_time_ms) all.push(liveBar);
    else all[all.length - 1] = liveBar;
  }
  return recentImpulse(all, 6);
}

/** Drop from recent swing high (last ~8 bars) — catches BUY under a dump even if net open→close is mixed. */
export function selloffFromSwingHigh(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { dumpPts: number; dumpPct: number } {
  const all = [...(bars ?? [])];
  if (liveBar && Number.isFinite(liveBar.close)) {
    const last = all[all.length - 1];
    if (!last || last.open_time_ms !== liveBar.open_time_ms) all.push(liveBar);
    else all[all.length - 1] = liveBar;
  }
  if (all.length < 2) return { dumpPts: 0, dumpPct: 0 };
  const window = all.slice(-8);
  const hi = Math.max(...window.map((b) => b.high));
  const close = window[window.length - 1]!.close;
  const dumpPts = hi - close;
  const dumpPct = dumpPts / Math.max(Math.abs(hi), 1e-9);
  return { dumpPts, dumpPct };
}

export function rallyFromSwingLow(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { rallyPts: number; rallyPct: number } {
  const all = [...(bars ?? [])];
  if (liveBar && Number.isFinite(liveBar.close)) {
    const last = all[all.length - 1];
    if (!last || last.open_time_ms !== liveBar.open_time_ms) all.push(liveBar);
    else all[all.length - 1] = liveBar;
  }
  if (all.length < 2) return { rallyPts: 0, rallyPct: 0 };
  const window = all.slice(-8);
  const lo = Math.min(...window.map((b) => b.low));
  const close = window[window.length - 1]!.close;
  const rallyPts = close - lo;
  const rallyPct = rallyPts / Math.max(Math.abs(lo), 1e-9);
  return { rallyPts, rallyPct };
}

/** ~7pt / 0.15% Gold — any clear dump under the swing high blocks new longs. */
const SELLOFF_BLOCK_PCT = 0.0015;
/** Soft short-net dump — ~3.5pt. Tighter than before (−0.15%). */
const SHORT_DUMP_BLOCK_PCT = 0.00075;

export function allowEntryAgainstImpulse(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): { ok: boolean; reason: string } {
  const short = shortNetMove(bars, liveBar);
  const offHigh = selloffFromSwingHigh(bars, liveBar);
  const offLow = rallyFromSwingLow(bars, liveBar);

  // HARD: never BUY under an active selloff (the two mīnus BUY trades)
  if (direction === 'BUY') {
    if (offHigh.dumpPct >= SELLOFF_BLOCK_PCT) {
      return {
        ok: false,
        reason: `BLOCK BUY · ${offHigh.dumpPts.toFixed(1)}pt under swing high (${(offHigh.dumpPct * 100).toFixed(2)}%) — no long into dump`,
      };
    }
    if (short.netPct <= -SHORT_DUMP_BLOCK_PCT) {
      return {
        ok: false,
        reason: `BLOCK BUY · short dump ${short.netPts.toFixed(1)}pt (${(short.netPct * 100).toFixed(2)}%) — no long into selloff`,
      };
    }
  }
  if (direction === 'SELL') {
    if (offLow.rallyPct >= SELLOFF_BLOCK_PCT) {
      return {
        ok: false,
        reason: `BLOCK SELL · ${offLow.rallyPts.toFixed(1)}pt off swing low (${(offLow.rallyPct * 100).toFixed(2)}%) — no short into rally`,
      };
    }
    if (short.netPct >= SHORT_DUMP_BLOCK_PCT) {
      return {
        ok: false,
        reason: `BLOCK SELL · short rally ${short.netPts.toFixed(1)}pt (${(short.netPct * 100).toFixed(2)}%) — no short into buy-move`,
      };
    }
  }

  const imp = recentImpulse(bars);
  if (!imp.dir) return { ok: true, reason: 'no strong recent impulse' };
  if (direction === 'SELL' && imp.dir === 'UP') {
    return {
      ok: false,
      reason: `BLOCK SELL · fresh UP impulse ${imp.netPts.toFixed(1)}pt (${(imp.netPct * 100).toFixed(2)}%) — no fade buy-move`,
    };
  }
  if (direction === 'BUY' && imp.dir === 'DOWN') {
    return {
      ok: false,
      reason: `BLOCK BUY · fresh DOWN impulse ${imp.netPts.toFixed(1)}pt (${(imp.netPct * 100).toFixed(2)}%) — no fade sell-move`,
    };
  }
  return { ok: true, reason: `impulse ${imp.dir} aligns` };
}

/**
 * Late-chase gate applies to breakout/expansion exhaustion only.
 * TREND regimes already ARE the move — blocking them as "late" misses the trade.
 */
export function lateChaseAppliesToSetup(setup: RegimeEntry['setup'], regime?: string | null): boolean {
  const r = normalizeRegime(regime);
  if (r === 'TREND_UP' || r === 'TREND_DOWN') return false;
  if (r === 'PULLBACK_UPTREND' || r === 'PULLBACK_DOWNTREND') return false;
  return setup === 'BREAKOUT' || setup === 'CONTINUATION';
}

/** Human detail when decideEntry returns null — shown on robot board. */
export function explainNoEntry(
  bar: TenSecBar,
  regime?: string | null,
  _closedBars?: TenSecBar[] | null
): string {
  const r = normalizeRegime(regime);
  const body = bodyPct(bar);
  const pts = bar.close - bar.open;
  const bits = [
    `body=${(body * 100).toFixed(2)}%/${pts.toFixed(1)}pt`,
    `rng=${(rangePct(bar) * 100).toFixed(2)}%`,
  ];
  if (signalBarTooLate(bar)) return `late bar · ${bits.join(' ')}`;
  if (!softLive(bar)) {
    return `regime ${r} · wait soft live (≥~2pt) · ${bits.join(' ')}`;
  }
  if (r === 'TREND_UP' && isRed(bar) === false && isGreen(bar) === false) {
    return `TREND_UP · flat live · ${bits.join(' ')}`;
  }
  if (r === 'TREND_DOWN' && isRed(bar) === false && isGreen(bar) === false) {
    return `TREND_DOWN · flat live · ${bits.join(' ')}`;
  }
  return `no regime timing · ${bits.join(' ')}`;
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

  if (signalBarTooLate(bar)) return null;
  if (!softLive(bar)) return null;

  // Align side with short window BEFORE regime-led timing (stops green bounce BUY in a dump)
  const short = shortNetMove(closedBars, bar);
  const offHigh = selloffFromSwingHigh(closedBars, bar);
  const offLow = rallyFromSwingLow(closedBars, bar);
  const buyBlocked =
    short.netPct <= -SHORT_DUMP_BLOCK_PCT || offHigh.dumpPct >= SELLOFF_BLOCK_PCT;
  const sellBlocked =
    short.netPct >= SHORT_DUMP_BLOCK_PCT || offLow.rallyPct >= SELLOFF_BLOCK_PCT;

  // ——— TREND: market type is the thesis; soft live times entry ———
  if (r === 'TREND_UP') {
    if (buyBlocked) return null;
    if (dip(bar) && isRed(bar)) {
      return { direction: 'BUY', setup: 'PULLBACK', reason: `${r} dip-buy · ${candle}` };
    }
    if (isGreen(bar)) {
      return { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} follow · ${candle}` };
    }
    return null;
  }
  if (r === 'TREND_DOWN') {
    if (sellBlocked) return null;
    if (rally(bar) && isGreen(bar)) {
      return { direction: 'SELL', setup: 'PULLBACK', reason: `${r} rally-sell · ${candle}` };
    }
    if (isRed(bar)) {
      return { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} follow · ${candle}` };
    }
    return null;
  }

  if (r === 'PULLBACK_UPTREND') {
    if (buyBlocked || !isGreen(bar)) return null;
    return { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} resume long · ${candle}` };
  }
  if (r === 'PULLBACK_DOWNTREND') {
    if (sellBlocked || !isRed(bar)) return null;
    return { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} resume short · ${candle}` };
  }

  if (r === 'EXPANSION') {
    const imp = recentImpulse(closedBars);
    // Prefer selloff/rally blocks over stale impulse label
    const flow: 'UP' | 'DOWN' | null = buyBlocked
      ? 'DOWN'
      : sellBlocked
        ? 'UP'
        : (short.dir ?? imp.dir);

    if (flow === 'UP') {
      if (buyBlocked) return null;
      if (isRed(bar)) {
        return {
          direction: 'BUY',
          setup: 'PULLBACK',
          reason: `EXPANSION UP dip-buy · ${candle}`,
        };
      }
      if (isGreen(bar)) {
        return {
          direction: 'BUY',
          setup: 'CONTINUATION',
          reason: `EXPANSION UP follow · ${candle}`,
        };
      }
      return null;
    }
    if (flow === 'DOWN') {
      if (sellBlocked) return null;
      if (isGreen(bar)) {
        return {
          direction: 'SELL',
          setup: 'PULLBACK',
          reason: `EXPANSION DOWN rally-sell · ${candle}`,
        };
      }
      if (isRed(bar)) {
        return {
          direction: 'SELL',
          setup: 'CONTINUATION',
          reason: `EXPANSION DOWN follow · ${candle}`,
        };
      }
      return null;
    }

    // No clear flow — do NOT guess green=BUY (that bought the dump)
    return null;
  }

  if (r === 'BREAKOUT_UP') {
    if (buyBlocked || isRed(bar)) return null;
    return { direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` };
  }
  if (r === 'BREAKOUT_DOWN') {
    if (sellBlocked || isGreen(bar)) return null;
    return { direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` };
  }

  return null;
}
