/**
 * Quality entry — trade real moves, skip chop fades.
 * TREND pullback/resume + EXPANSION/BREAKOUT follow (clear body).
 * SKIP: RANGE / FADE / REVERSAL / quiet noise.
 */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { bodyPct, isMoving10s, rangePct, type TenSecBar } from './tenSecondOhlc.js';

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK' | 'BREAKOUT' | 'FADE' | 'REVERSAL';
  reason: string;
};

function movingOrNull(bar: TenSecBar): boolean {
  return isMoving10s(bar);
}

/** Clearer pullback than tick noise — ~0.9pt @ Gold 4600. */
const PULLBACK_BODY_PCT = 0.0002;

function dip(bar: TenSecBar): boolean {
  return bodyPct(bar) <= -PULLBACK_BODY_PCT;
}

function rally(bar: TenSecBar): boolean {
  return bodyPct(bar) >= PULLBACK_BODY_PCT;
}

/** Expansion/breakout needs a real body — ~1.3pt Gold. */
const IMPULSE_BODY_PCT = 0.00028;

function strongBody(bar: TenSecBar): boolean {
  return Math.abs(bodyPct(bar)) >= IMPULSE_BODY_PCT || Math.abs(bar.close - bar.open) >= 0.12;
}

function describe(bar: TenSecBar): string {
  return `10s O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bodyPct(bar) * 100).toFixed(3)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
}

/** Signal bar already spent the move — chasing junk. ~0.25% ≈ 11pt @ Gold 4600. */
const LATE_SIGNAL_BODY_PCT = 0.0025;

export function signalBarTooLate(bar: TenSecBar): boolean {
  return Math.abs(bodyPct(bar)) >= LATE_SIGNAL_BODY_PCT;
}

/**
 * Net impulse over recent 10s bars (~lookback×10s).
 * ~0.12% on Gold ≈ 5.5pt — blocks fading a fresh spike with counter trades.
 */
export function recentImpulse(
  bars: TenSecBar[] | null | undefined,
  lookback = 12
): { dir: 'UP' | 'DOWN' | null; netPct: number; netPts: number } {
  if (!bars?.length) return { dir: null, netPct: 0, netPts: 0 };
  const window = bars.slice(-Math.max(lookback, 2));
  if (window.length < 2) return { dir: null, netPct: 0, netPts: 0 };
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const netPts = last.close - first.open;
  const mid = Math.max(Math.abs(first.open), 1e-9);
  const netPct = netPts / mid;
  if (netPct >= 0.0012) return { dir: 'UP', netPct, netPts };
  if (netPct <= -0.0012) return { dir: 'DOWN', netPct, netPts };
  return { dir: null, netPct, netPts };
}

/**
 * Never SELL into a fresh UP impulse / BUY into a fresh DOWN dump.
 */
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
 * Entry:
 * - TREND_UP dip-buy / TREND_DOWN rally-sell
 * - PULLBACK_* resume
 * - EXPANSION / BREAKOUT follow clear body (was skipped → eternal WAIT on real moves)
 *
 * SKIP: RANGE chop, FADE, REVERSAL, quiet.
 */
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

  // Real volatility — follow the body (15:30 Gold dump was EXPANSION and was skipped → WAIT forever)
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
