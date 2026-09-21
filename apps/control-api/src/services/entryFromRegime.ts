/** 10s OHLC + 14-regime entry — regime is the classifier; this picks the suitable setup. */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { ENTRY_DIP, ENTRY_RALLY } from './regimeBands.js';
import {
  bodyPct,
  isMoving10s,
  isSpike10s,
  rangePct,
  type TenSecBar,
} from './tenSecondOhlc.js';

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK' | 'BREAKOUT' | 'FADE' | 'REVERSAL';
  reason: string;
};

/** Same MOVE floor as isMoving / persist — shared regimeBands ladder */
const DIP = ENTRY_DIP;
const RALLY = ENTRY_RALLY;

function movingOrNull(bar: TenSecBar): boolean {
  return isMoving10s(bar);
}

function dip(bar: TenSecBar): boolean {
  return bodyPct(bar) <= DIP;
}

function rally(bar: TenSecBar): boolean {
  return bodyPct(bar) >= RALLY;
}

function describe(bar: TenSecBar): string {
  return `10s O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bodyPct(bar) * 100).toFixed(3)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
}

/** Impulse follow — used on SPIKE inside RANGE/COMPRESSION (no fade into HardInv). */
function followSpike(bar: TenSecBar, regime: string): RegimeEntry | null {
  if (!isSpike10s(bar) || !movingOrNull(bar)) return null;
  const candle = describe(bar);
  if (rally(bar))
    return { direction: 'BUY', setup: 'BREAKOUT', reason: `${regime} SPIKE follow up · ${candle}` };
  if (dip(bar))
    return { direction: 'SELL', setup: 'BREAKOUT', reason: `${regime} SPIKE follow down · ${candle}` };
  return null;
}

/**
 * Suitable entry for the current 10s regime. Returns null = WAIT (not a skip-forever).
 * Does not fade a trend (no SELL in TREND_UP, no BUY in TREND_DOWN).
 * SPIKE bars in RANGE/COMPRESSION follow immediately (not fade pushbacks).
 */
export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null
): RegimeEntry | null {
  const r: RegimeName = normalizeRegime(regime);
  const candle = describe(bar);

  if (r === 'UNKNOWN') return null;

  // TRANSITION (rare after sticky classify) — follow body like EXPANSION, not starve
  if (r === 'TRANSITION') {
    if (!movingOrNull(bar)) return null;
    if (rally(bar))
      return { direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow up · ${candle}` };
    if (dip(bar))
      return { direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow down · ${candle}` };
    return null;
  }

  // COMPRESSION: SPIKE → follow now; micro move → fade
  if (r === 'COMPRESSION') {
    const spike = followSpike(bar, r);
    if (spike) return spike;
    if (!movingOrNull(bar)) return null;
    if (dip(bar)) return { direction: 'BUY', setup: 'FADE', reason: `${r} fade dip · ${candle}` };
    if (rally(bar)) return { direction: 'SELL', setup: 'FADE', reason: `${r} fade rally · ${candle}` };
    return null;
  }

  if (r === 'TREND_UP') {
    if (!movingOrNull(bar)) return null;
    if (dip(bar)) return { direction: 'BUY', setup: 'PULLBACK', reason: `${r} dip-buy · ${candle}` };
    // With-trend: do not starve a clean up-bar waiting forever for a pullback
    if (rally(bar))
      return { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} with-trend · ${candle}` };
    return null;
  }
  if (r === 'TREND_DOWN') {
    if (!movingOrNull(bar)) return null;
    if (rally(bar))
      return { direction: 'SELL', setup: 'PULLBACK', reason: `${r} rally-sell · ${candle}` };
    if (dip(bar))
      return { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} with-trend · ${candle}` };
    return null;
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

  // RANGE — SPIKE follow immediately; only micro bars still fade pushbacks
  if (r === 'RANGE') {
    const spike = followSpike(bar, r);
    if (spike) return spike;
    if (!movingOrNull(bar)) return null;
    if (dip(bar)) return { direction: 'BUY', setup: 'FADE', reason: `${r} fade dip · ${candle}` };
    if (rally(bar)) return { direction: 'SELL', setup: 'FADE', reason: `${r} fade rally · ${candle}` };
    return null;
  }

  return null;
}
