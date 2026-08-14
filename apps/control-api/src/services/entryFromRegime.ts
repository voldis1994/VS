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
  const last = w[w.length - 1]!;
  // A green continuation with non-negative net is a climb — never call it DOWN.
  if (bodyPct(last) > 0.00008 && net >= 0) return 'UP';
  if (bodyPct(last) < -0.00008 && net <= 0) return 'DOWN';
  if (net > 0.0003 && persist >= 0) return 'UP';
  if (net < -0.0003 && persist <= 0) return 'DOWN';
  if (net > 0.0006) return 'UP';
  if (net < -0.0006) return 'DOWN';
  if (persist > 0.25 && net > 0) return 'UP';
  if (persist < -0.25 && net < 0) return 'DOWN';
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
  const last = w[w.length - 1]!;
  if (last.close > last.open && net >= 0) return 'UP';
  if (last.close < last.open && net <= 0) return 'DOWN';
  if (net > 0.0008 && persist >= 0) return 'UP';
  if (net < -0.0008 && persist <= 0) return 'DOWN';
  if (net > 0.0015) return 'UP';
  if (net < -0.0015) return 'DOWN';
  if (persist > 0.2 && net > 0.0004) return 'UP';
  if (persist < -0.2 && net < -0.0004) return 'DOWN';
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
  if (bias === 'FLAT') return false;
  if (bias === 'UP') return direction === 'BUY';
  return direction === 'SELL';
}

/** True when an order would sell a climb or buy a dump (FLAT does not guess). */
export function isCountertrendSide(direction: 'BUY' | 'SELL', bias: TrendBias): boolean {
  return !allowsBias(direction, bias);
}

/** Last-line veto: never SELL a green 10s, never SELL unless lasting DOWN, never BUY unless lasting UP. */
export function denyWithTrendEntry(
  direction: 'BUY' | 'SELL',
  bar: TenSecBar | null | undefined,
  bias: TrendBias,
  recent?: TenSecBar[] | null,
  opts?: { exhaustion?: boolean }
): string | null {
  if (bar && Number.isFinite(bar.open) && Number.isFinite(bar.close)) {
    if (direction === 'SELL' && rally(bar)) return 'no SELL on green 10s (would sell the climb)';
    if (direction === 'BUY' && dip(bar) && !opts?.exhaustion && bias !== 'UP') {
      return 'no BUY on red 10s without UP bias';
    }
  }
  if (opts?.exhaustion) return null;
  if (isCountertrendSide(direction, bias)) {
    return direction === 'SELL'
      ? `no SELL unless lasting DOWN (bias ${bias})`
      : `no BUY unless lasting UP (bias ${bias})`;
  }
  const w = (recent || []).filter((b) => b && Number.isFinite(b.close));
  if (w.length >= 4) {
    const net = (w[w.length - 1]!.close - w[0]!.open) / Math.max(Math.abs(w[0]!.open), 1e-9);
    if (direction === 'SELL' && net > 0) return 'no SELL, 10s net still up';
    if (direction === 'BUY' && net < 0) return 'no BUY, 10s net still down';
  }
  return null;
}

function withBar(recent: TenSecBar[] | null | undefined, bar: TenSecBar): TenSecBar[] {
  const w = (recent || []).filter((b) => b && Number.isFinite(b.close));
  const last = w[w.length - 1];
  const same =
    last &&
    Math.abs(last.open - bar.open) < 1e-9 &&
    Math.abs(last.close - bar.close) < 1e-9;
  if (!same) w.push(bar);
  return w;
}

/**
 * SELL/BUY after a large move — only with confirmation on the NEXT closed 10s.
 * Does not sell the impulse candle itself (the circled gold sell).
 */
export function decideExhaustionEntry(bars: TenSecBar[]): RegimeEntry | null {
  const w = bars.filter((b) => b && Number.isFinite(b.close));
  if (w.length < 3) return null;
  const cur = w[w.length - 1]!;
  const prev = w[w.length - 2]!;
  if (!isMoving10s(cur)) return null;

  const prior = w.slice(0, -1).slice(-8);
  const priorNet =
    (prev.close - prior[0]!.open) / Math.max(Math.abs(prior[0]!.open), 1e-9);
  const prevBody = bodyPct(prev);

  const largeUp = prevBody >= 0.0008 || priorNet >= 0.0015;
  const largeDown = prevBody <= -0.0008 || priorNet <= -0.0015;

  // Confirm SELL: after the up-move, a red 10s that closes below the prior close.
  if (largeUp && priorNet > 0 && dip(cur) && cur.close < prev.close) {
    return {
      direction: 'SELL',
      setup: 'FADE',
      reason: `EXHAUSTION confirm after large up · prev body=${(prevBody * 100).toFixed(3)}% priorNet=${(priorNet * 100).toFixed(3)}% · ${describe(cur)}`,
    };
  }
  // Confirm BUY: after the dump, a green 10s that closes above the prior close.
  if (largeDown && priorNet < 0 && rally(cur) && cur.close > prev.close) {
    return {
      direction: 'BUY',
      setup: 'FADE',
      reason: `EXHAUSTION confirm after large down · prev body=${(prevBody * 100).toFixed(3)}% priorNet=${(priorNet * 100).toFixed(3)}% · ${describe(cur)}`,
    };
  }
  return null;
}

/** Last 1m closed opposite to a lasting climb/dump — enough confirmation to fade. */
export function minuteExhaustionConfirmed(
  direction: 'BUY' | 'SELL',
  candles: Array<{ open: number; close: number }>
): boolean {
  const w = candles.filter((c) => c && Number.isFinite(c.open) && Number.isFinite(c.close));
  if (w.length < 8) return false;
  const last = w[w.length - 1]!;
  const prev = w[w.length - 2]!;
  const first = w[0]!;
  const priorNet = (prev.close - first.open) / Math.max(Math.abs(first.open), 1e-9);
  if (direction === 'SELL') {
    return priorNet >= 0.0012 && last.close < last.open && last.close < prev.close;
  }
  if (direction === 'BUY') {
    return priorNet <= -0.0012 && last.close > last.open && last.close > prev.close;
  }
  return false;
}

function gate(hit: RegimeEntry | null, bias: TrendBias, bar: TenSecBar): RegimeEntry | null {
  if (!hit) return null;
  const deny = denyWithTrendEntry(hit.direction, bar, bias);
  if (deny) return null;
  return { ...hit, reason: `${hit.reason} · bias ${bias}` };
}

/**
 * Suitable entry for the current 10s regime. Returns null = WAIT.
 * With-trend only: never fade RANGE, never sell a climb, never buy a dump.
 */
export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null,
  bias: TrendBias = 'FLAT',
  recent?: TenSecBar[] | null
): RegimeEntry | null {
  const exhaustion = decideExhaustionEntry(withBar(recent, bar));
  if (exhaustion) return { ...exhaustion, reason: `${exhaustion.reason} · bias ${bias}` };

  const r: RegimeName = normalizeRegime(regime);
  const candle = describe(bar);

  if (r === 'UNKNOWN' || r === 'TRANSITION' || r === 'COMPRESSION') return null;
  // Countertrend by definition — WAIT, do not hunt SELL SCALP / BUY LONG against the move.
  if (
    r === 'RANGE' ||
    r === 'FAILED_BREAKOUT_UP' ||
    r === 'FAILED_BREAKOUT_DOWN' ||
    r === 'REVERSAL_CANDIDATE'
  ) {
    return null;
  }

  if (r === 'TREND_UP') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return gate({ direction: 'BUY', setup: 'PULLBACK', reason: `${r} dip-buy · ${candle}` }, bias, bar);
  }
  if (r === 'TREND_DOWN') {
    // Follow the dump (red bar) — never rally-sell a green breakout into a climb.
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return gate({ direction: 'SELL', setup: 'PULLBACK', reason: `${r} follow dump · ${candle}` }, bias, bar);
  }

  if (r === 'PULLBACK_UPTREND') {
    if (!movingOrNull(bar) || !rally(bar)) return null;
    return gate(
      { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} resume long · ${candle}` },
      bias,
      bar
    );
  }
  if (r === 'PULLBACK_DOWNTREND') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return gate(
      { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} resume short · ${candle}` },
      bias,
      bar
    );
  }

  if (r === 'BREAKOUT_UP') {
    if (!movingOrNull(bar) || dip(bar) || !rally(bar)) return null;
    return gate({ direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` }, bias, bar);
  }
  if (r === 'BREAKOUT_DOWN') {
    if (!movingOrNull(bar) || rally(bar) || !dip(bar)) return null;
    return gate({ direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` }, bias, bar);
  }

  if (r === 'EXPANSION') {
    if (!movingOrNull(bar) || bias === 'FLAT') return null;
    if (rally(bar)) {
      return gate({ direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow up · ${candle}` }, bias, bar);
    }
    if (dip(bar)) {
      return gate({ direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow down · ${candle}` }, bias, bar);
    }
    return null;
  }

  return null;
}
