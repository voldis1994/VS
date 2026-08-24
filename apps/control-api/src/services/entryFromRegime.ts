/** 10s OHLC + 14-regime entry — regime is the classifier; this picks the suitable setup. */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import {
  BREAKOUT_BODY_PCT,
  bodyPct,
  isMoving10s,
  isMovingBreakout10s,
  rangePct,
  type TenSecBar,
} from './tenSecondOhlc.js';

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK' | 'BREAKOUT' | 'FADE' | 'REVERSAL';
  reason: string;
};

function movingOrNull(bar: TenSecBar): boolean {
  return isMoving10s(bar);
}

function dip(bar: TenSecBar): boolean {
  return bodyPct(bar) <= -0.00015;
}

function rally(bar: TenSecBar): boolean {
  return bodyPct(bar) >= 0.00015;
}

function describe(bar: TenSecBar): string {
  return `10s O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bodyPct(bar) * 100).toFixed(3)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
}

/**
 * Suitable entry for the current 10s regime. Returns null = WAIT (not a skip-forever).
 * Does not fade a trend (no SELL in TREND_UP, no BUY in TREND_DOWN).
 */
export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null
): RegimeEntry | null {
  const r: RegimeName = normalizeRegime(regime);
  const candle = describe(bar);

  if (r === 'UNKNOWN' || r === 'TRANSITION') return null;
  if (r === 'COMPRESSION') return null; // wait for expansion / breakout

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

  if (r === 'BREAKOUT_UP') {
    if (!movingOrNull(bar) || dip(bar)) return null;
    return { direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` };
  }
  if (r === 'BREAKOUT_DOWN') {
    if (!movingOrNull(bar) || rally(bar)) return null;
    return { direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` };
  }

  if (r === 'FAILED_BREAKOUT_UP') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return { direction: 'SELL', setup: 'FADE', reason: `${r} fade failed long · ${candle}` };
  }
  if (r === 'FAILED_BREAKOUT_DOWN') {
    if (!movingOrNull(bar) || !rally(bar)) return null;
    return { direction: 'BUY', setup: 'FADE', reason: `${r} fade failed short · ${candle}` };
  }

  if (r === 'REVERSAL_CANDIDATE') {
    if (!movingOrNull(bar)) return null;
    if (dip(bar)) return { direction: 'SELL', setup: 'REVERSAL', reason: `${r} · ${candle}` };
    if (rally(bar)) return { direction: 'BUY', setup: 'REVERSAL', reason: `${r} · ${candle}` };
    return null;
  }

  if (r === 'EXPANSION') {
    if (!movingOrNull(bar)) return null;
    if (rally(bar)) return { direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow up · ${candle}` };
    if (dip(bar)) return { direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow down · ${candle}` };
    return null;
  }

  // RANGE — mean-reversion only on a clearer 10s body (cuts Capital micro-noise fades)
  if (r === 'RANGE') {
    if (!movingOrNull(bar)) return null;
    const bp = bodyPct(bar);
    if (bp <= -0.00028) return { direction: 'BUY', setup: 'FADE', reason: `${r} fade dip · ${candle}` };
    if (bp >= 0.00028) return { direction: 'SELL', setup: 'FADE', reason: `${r} fade rally · ${candle}` };
    return null;
  }

  return null;
}

/**
 * Live entry = BREAKOUT_UP/DOWN + TREND_UP/DOWN.
 * Also accepts structural break from bar history when regime label lags.
 */
export function decideEntryBreakoutOnly(
  bar: TenSecBar,
  regime?: string | null,
  histBars?: TenSecBar[] | null
): RegimeEntry | null {
  const r: RegimeName = normalizeRegime(regime);
  const candle = describe(bar);

  if (r === 'BREAKOUT_UP') {
    if (!isMovingBreakout10s(bar) || bar.close < bar.open) return null;
    return { direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` };
  }
  if (r === 'BREAKOUT_DOWN') {
    if (!isMovingBreakout10s(bar) || bar.close > bar.open) return null;
    return { direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` };
  }

  if (r === 'TREND_UP') {
    if (!movingOrNull(bar)) return null;
    if (dip(bar)) return { direction: 'BUY', setup: 'PULLBACK', reason: `${r} dip-buy · ${candle}` };
    if (rally(bar) && isMovingBreakout10s(bar)) {
      return { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} follow · ${candle}` };
    }
    return null;
  }
  if (r === 'TREND_DOWN') {
    if (!movingOrNull(bar)) return null;
    if (rally(bar)) return { direction: 'SELL', setup: 'PULLBACK', reason: `${r} rally-sell · ${candle}` };
    if (dip(bar) && isMovingBreakout10s(bar)) {
      return { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} follow · ${candle}` };
    }
    return null;
  }

  // Structural fallback: close beyond prior highs/lows (same idea as live BO classify)
  const bars = histBars && histBars.length >= 4 ? histBars : null;
  if (!bars || !isMovingBreakout10s(bar)) return null;
  const prior = bars.slice(0, -1).slice(-7);
  if (prior.length < 3) return null;
  const hi = Math.max(...prior.map((b) => b.high));
  const lo = Math.min(...prior.map((b) => b.low));
  const bp = bodyPct(bar);
  const bodyAbs = Math.abs(bar.close - bar.open);
  const strong = Math.abs(bp) >= BREAKOUT_BODY_PCT || bodyAbs >= 0.08;
  if (bar.close > hi && bar.close > bar.open && strong && bp > 0) {
    return {
      direction: 'BUY',
      setup: 'BREAKOUT',
      reason: `STRUCT BO long · close>${hi.toFixed(2)} · ${candle}`,
    };
  }
  if (bar.close < lo && bar.close < bar.open && strong && bp < 0) {
    return {
      direction: 'SELL',
      setup: 'BREAKOUT',
      reason: `STRUCT BO short · close<${lo.toFixed(2)} · ${candle}`,
    };
  }

  return null;
}
