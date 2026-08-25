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

export function allowEntryAgainstImpulse(
  direction: 'BUY' | 'SELL',
  bars: TenSecBar[] | null | undefined
): { ok: boolean; reason: string } {
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

  // ——— TREND: market type is the thesis; soft live times entry ———
  if (r === 'TREND_UP') {
    if (dip(bar) && isRed(bar)) {
      return { direction: 'BUY', setup: 'PULLBACK', reason: `${r} dip-buy · ${candle}` };
    }
    if (isGreen(bar)) {
      return { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} follow · ${candle}` };
    }
    return null;
  }
  if (r === 'TREND_DOWN') {
    if (rally(bar) && isGreen(bar)) {
      return { direction: 'SELL', setup: 'PULLBACK', reason: `${r} rally-sell · ${candle}` };
    }
    if (isRed(bar)) {
      return { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} follow · ${candle}` };
    }
    return null;
  }

  if (r === 'PULLBACK_UPTREND') {
    if (!isGreen(bar)) return null;
    return { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} resume long · ${candle}` };
  }
  if (r === 'PULLBACK_DOWNTREND') {
    if (!isRed(bar)) return null;
    return { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} resume short · ${candle}` };
  }

  if (r === 'EXPANSION') {
    const imp = recentImpulse(closedBars);

    if (imp.dir === 'UP') {
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
    if (imp.dir === 'DOWN') {
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

    // No multi-bar impulse — still follow live bar with the expansion regime
    if (isGreen(bar)) {
      return { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} follow up · ${candle}` };
    }
    if (isRed(bar)) {
      return { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} follow down · ${candle}` };
    }
    return null;
  }

  if (r === 'BREAKOUT_UP') {
    if (isRed(bar)) return null;
    return { direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` };
  }
  if (r === 'BREAKOUT_DOWN') {
    if (isGreen(bar)) return null;
    return { direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` };
  }

  return null;
}
