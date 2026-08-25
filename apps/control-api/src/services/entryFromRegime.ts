/**
 * Quality entry on 5m — fewer trades, larger bodies.
 * TREND pullback/resume + EXPANSION/BREAKOUT follow.
 * SKIP: RANGE chop, FADE, REVERSAL, quiet.
 */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { bodyPct, isMoving5m, rangePct, type TenSecBar } from './tenSecondOhlc.js';

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK' | 'BREAKOUT' | 'FADE' | 'REVERSAL';
  reason: string;
};

function movingOrNull(bar: TenSecBar): boolean {
  return isMoving5m(bar);
}

/** Pullback ~0.10% ≈ 4.6pt Gold. */
const PULLBACK_BODY_PCT = 0.001;

function dip(bar: TenSecBar): boolean {
  return bodyPct(bar) <= -PULLBACK_BODY_PCT;
}

function rally(bar: TenSecBar): boolean {
  return bodyPct(bar) >= PULLBACK_BODY_PCT;
}

/** Expansion/breakout ~0.15% ≈ 7pt Gold. */
const IMPULSE_BODY_PCT = 0.0015;

function strongBody(bar: TenSecBar): boolean {
  return Math.abs(bodyPct(bar)) >= IMPULSE_BODY_PCT || Math.abs(bar.close - bar.open) >= 6;
}

function describe(bar: TenSecBar): string {
  return `5m O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bodyPct(bar) * 100).toFixed(3)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
}

/** Already spent the 5m move — ~0.45% ≈ 21pt Gold. */
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

export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null
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

  if (r === 'TREND_UP') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return { direction: 'BUY', setup: 'PULLBACK', reason: `${r} dip-buy · ${candle}` };
  }
  if (r === 'TREND_DOWN') {
    if (!movingOrNull(bar) || !rally(bar)) return null;
    return { direction: 'SELL', setup: 'PULLBACK', reason: `${r} rally-sell · ${candle}` };
  }

  if (r === 'PULLBACK_UPTREND') {
    if (!movingOrNull(bar) || !rally(bar)) return null;
    return { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} resume long · ${candle}` };
  }
  if (r === 'PULLBACK_DOWNTREND') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} resume short · ${candle}` };
  }

  if (r === 'EXPANSION') {
    if (!movingOrNull(bar) || !strongBody(bar)) return null;
    if (rally(bar)) {
      return { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} follow up · ${candle}` };
    }
    if (dip(bar)) {
      return { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} follow down · ${candle}` };
    }
    return null;
  }

  if (r === 'BREAKOUT_UP') {
    if (!movingOrNull(bar) || dip(bar) || !strongBody(bar)) return null;
    return { direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` };
  }
  if (r === 'BREAKOUT_DOWN') {
    if (!movingOrNull(bar) || rally(bar) || !strongBody(bar)) return null;
    return { direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` };
  }

  return null;
}
