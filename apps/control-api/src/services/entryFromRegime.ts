/** 10s OHLC + 14-regime entry — regime is the classifier; this picks the suitable setup. */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { ENTRY_DIP, ENTRY_RALLY } from './regimeBands.js';
import {
  bodyPct,
  isMoving10s,
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

/**
 * Suitable entry for the current 10s regime. Returns null = WAIT (not a skip-forever).
 * With-candle only: green→BUY / red→SELL — never knife green→SELL / red→BUY.
 * COMPRESSION / TRANSITION / RANGE = WAIT (no open fade Soft spam).
 */
export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null
): RegimeEntry | null {
  const r: RegimeName = normalizeRegime(regime);
  const candle = describe(bar);

  if (r === 'UNKNOWN') return null;

  // COMPRESSION / TRANSITION / RANGE — WAIT, never open-fade knife
  // (green→SELL / red→BUY was Soft spam; live "HFT takes the opposite").
  if (r === 'COMPRESSION' || r === 'TRANSITION' || r === 'RANGE') {
    return null;
  }

  // TREND: follow the live candle only (continuation). No dip-buy / rally-sell —
  // those are red→BUY / green→SELL, the same Soft knife the desk must not take.
  if (r === 'TREND_UP') {
    if (!movingOrNull(bar) || !rally(bar)) return null;
    return { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} follow up · ${candle}` };
  }
  if (r === 'TREND_DOWN') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} follow down · ${candle}` };
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

  return null;
}
