/**
 * Quality entry on 5m — fewer trades, larger bodies.
 * TREND pullback/resume + EXPANSION/BREAKOUT follow impulse (never fade).
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

/** Softer follow when multi-bar impulse already confirmed — ~4pt Gold. */
function followBody(bar: TenSecBar): boolean {
  return strongBody(bar) || Math.abs(bar.close - bar.open) >= 4;
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

/** Human detail when decideEntry returns null — shown on robot board. */
export function explainNoEntry(
  bar: TenSecBar,
  regime?: string | null,
  closedBars?: TenSecBar[] | null
): string {
  const r = normalizeRegime(regime);
  const body = bodyPct(bar);
  const pts = bar.close - bar.open;
  const bits = [
    `body=${(body * 100).toFixed(2)}%/${pts.toFixed(1)}pt`,
    `rng=${(rangePct(bar) * 100).toFixed(2)}%`,
  ];
  if (signalBarTooLate(bar)) return `late bar · ${bits.join(' ')}`;
  if (r === 'EXPANSION' || r === 'BREAKOUT_UP' || r === 'BREAKOUT_DOWN') {
    const imp = recentImpulse(closedBars);
    if (!movingOrNull(bar) && !followBody(bar)) {
      return `need stronger live body (~4–6pt) · ${bits.join(' ')}${imp.dir ? ` · impulse ${imp.dir}` : ''}`;
    }
  }
  if (r === 'TREND_UP' && !dip(bar)) return `TREND_UP waits dip · ${bits.join(' ')}`;
  if (r === 'TREND_DOWN' && !rally(bar)) return `TREND_DOWN waits rally · ${bits.join(' ')}`;
  return `no quality setup · ${bits.join(' ')}`;
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
    const imp = recentImpulse(closedBars);

    // Follow the multi-bar impulse — never fade an UP expansion with SELL (or DOWN with BUY)
    if (imp.dir === 'UP') {
      if (dip(bar) && movingOrNull(bar)) {
        return {
          direction: 'BUY',
          setup: 'PULLBACK',
          reason: `EXPANSION UP dip-buy · ${candle}`,
        };
      }
      if (rally(bar) && followBody(bar) && movingOrNull(bar)) {
        return {
          direction: 'BUY',
          setup: 'CONTINUATION',
          reason: `EXPANSION UP follow · ${candle}`,
        };
      }
      return null;
    }
    if (imp.dir === 'DOWN') {
      if (rally(bar) && movingOrNull(bar)) {
        return {
          direction: 'SELL',
          setup: 'PULLBACK',
          reason: `EXPANSION DOWN rally-sell · ${candle}`,
        };
      }
      if (dip(bar) && followBody(bar) && movingOrNull(bar)) {
        return {
          direction: 'SELL',
          setup: 'CONTINUATION',
          reason: `EXPANSION DOWN follow · ${candle}`,
        };
      }
      return null;
    }

    // No clear multi-bar impulse — require strong single-bar body
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
