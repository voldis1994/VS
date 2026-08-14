/** 10s OHLC + 14-regime entry — regime is the classifier; this picks the suitable setup. */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { bodyPct, isMoving10s, rangePct, type TenSecBar } from './tenSecondOhlc.js';

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK' | 'BREAKOUT' | 'FADE' | 'REVERSAL';
  reason: string;
};

export type TrendBias = 'UP' | 'DOWN' | 'FLAT';

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

function netAndPersist(
  firstOpen: number,
  lastClose: number,
  upN: number,
  downN: number,
  n: number
): { net: number; persist: number } {
  const denom = Math.max(Math.abs(firstOpen), 1e-9);
  return { net: (lastClose - firstOpen) / denom, persist: n > 0 ? (upN - downN) / n : 0 };
}

/** Higher-horizon bias from recent 10s bars — blocks SELL-into-climb / BUY-into-dump. */
export function trendBiasFromBars(bars: TenSecBar[]): TrendBias {
  const w = bars.filter((b) => b && Number.isFinite(b.close)).slice(-24);
  if (w.length < 4) return 'FLAT';
  const bodies = w.map(bodyPct);
  const upN = bodies.filter((v) => v > 0.00008).length;
  const downN = bodies.filter((v) => v < -0.00008).length;
  const { net, persist } = netAndPersist(w[0]!.open, w[w.length - 1]!.close, upN, downN, w.length);
  if (net > 0.0007 && persist >= 0) return 'UP';
  if (net < -0.0007 && persist <= 0) return 'DOWN';
  if (net > 0.0012) return 'UP';
  if (net < -0.0012) return 'DOWN';
  if (persist > 0.35 && net > 0) return 'UP';
  if (persist < -0.35 && net < 0) return 'DOWN';
  return 'FLAT';
}

/** Lasting climb/dump from 1m candles — RANGE chop at the top of a rally still counts as UP. */
export function trendBiasFromMinuteCandles(
  candles: Array<{ open: number; close: number }>
): TrendBias {
  const w = candles.filter((c) => c && Number.isFinite(c.open) && Number.isFinite(c.close)).slice(-20);
  if (w.length < 8) return 'FLAT';
  const upN = w.filter((c) => c.close > c.open).length;
  const downN = w.filter((c) => c.close < c.open).length;
  const { net, persist } = netAndPersist(w[0]!.open, w[w.length - 1]!.close, upN, downN, w.length);
  if (net > 0.002 && persist >= 0) return 'UP';
  if (net < -0.002 && persist <= 0) return 'DOWN';
  if (net > 0.0035) return 'UP';
  if (net < -0.0035) return 'DOWN';
  if (persist > 0.25 && net > 0.001) return 'UP';
  if (persist < -0.25 && net < -0.001) return 'DOWN';
  return 'FLAT';
}

/** 1m (lasting) wins on conflict — a pullback in an uptrend is still only-BUY. */
export function mergeTrendBias(shortTf: TrendBias, lasting: TrendBias): TrendBias {
  if (shortTf === lasting) return shortTf;
  if (lasting !== 'FLAT') return lasting;
  return shortTf;
}

export function resolveTrendBias(
  tenSec: TenSecBar[],
  minutes?: Array<{ open: number; close: number }> | null
): TrendBias {
  return mergeTrendBias(trendBiasFromBars(tenSec), trendBiasFromMinuteCandles(minutes || []));
}

function allowsBias(direction: 'BUY' | 'SELL', bias: TrendBias): boolean {
  if (bias === 'FLAT') return true;
  if (bias === 'UP') return direction === 'BUY';
  return direction === 'SELL';
}

function gate(hit: RegimeEntry | null, bias: TrendBias): RegimeEntry | null {
  if (!hit) return null;
  if (!allowsBias(hit.direction, bias)) return null;
  return { ...hit, reason: `${hit.reason} · bias ${bias}` };
}

/**
 * Suitable entry for the current 10s regime. Returns null = WAIT.
 * Respects higher-horizon bias: no SELL SCALP into a climb, no BUY LONG into a dump.
 */
export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null,
  bias: TrendBias = 'FLAT'
): RegimeEntry | null {
  const r: RegimeName = normalizeRegime(regime);
  const candle = describe(bar);

  if (r === 'UNKNOWN' || r === 'TRANSITION') return null;
  if (r === 'COMPRESSION') return null;

  if (r === 'TREND_UP') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return gate({ direction: 'BUY', setup: 'PULLBACK', reason: `${r} dip-buy · ${candle}` }, bias);
  }
  if (r === 'TREND_DOWN') {
    if (!movingOrNull(bar) || !rally(bar)) return null;
    return gate({ direction: 'SELL', setup: 'PULLBACK', reason: `${r} rally-sell · ${candle}` }, bias);
  }

  if (r === 'PULLBACK_UPTREND') {
    if (!movingOrNull(bar) || !rally(bar)) return null;
    return gate(
      { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} resume long · ${candle}` },
      bias
    );
  }
  if (r === 'PULLBACK_DOWNTREND') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return gate(
      { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} resume short · ${candle}` },
      bias
    );
  }

  if (r === 'BREAKOUT_UP') {
    if (!movingOrNull(bar) || dip(bar)) return null;
    return gate({ direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` }, bias);
  }
  if (r === 'BREAKOUT_DOWN') {
    if (!movingOrNull(bar) || rally(bar)) return null;
    return gate({ direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` }, bias);
  }

  if (r === 'FAILED_BREAKOUT_UP') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return gate(
      { direction: 'SELL', setup: 'FADE', reason: `${r} fade failed long · ${candle}` },
      bias
    );
  }
  if (r === 'FAILED_BREAKOUT_DOWN') {
    if (!movingOrNull(bar) || !rally(bar)) return null;
    return gate(
      { direction: 'BUY', setup: 'FADE', reason: `${r} fade failed short · ${candle}` },
      bias
    );
  }

  if (r === 'REVERSAL_CANDIDATE') {
    if (!movingOrNull(bar)) return null;
    if (dip(bar)) {
      return gate({ direction: 'SELL', setup: 'REVERSAL', reason: `${r} · ${candle}` }, bias);
    }
    if (rally(bar)) {
      return gate({ direction: 'BUY', setup: 'REVERSAL', reason: `${r} · ${candle}` }, bias);
    }
    return null;
  }

  if (r === 'EXPANSION') {
    if (!movingOrNull(bar)) return null;
    if (rally(bar)) {
      return gate({ direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow up · ${candle}` }, bias);
    }
    if (dip(bar)) {
      return gate({ direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow down · ${candle}` }, bias);
    }
    return null;
  }

  if (r === 'RANGE') {
    if (!movingOrNull(bar)) return null;
    if (dip(bar)) {
      return gate({ direction: 'BUY', setup: 'FADE', reason: `${r} fade dip · ${candle}` }, bias);
    }
    if (rally(bar)) {
      return gate({ direction: 'SELL', setup: 'FADE', reason: `${r} fade rally · ${candle}` }, bias);
    }
    return null;
  }

  return null;
}
