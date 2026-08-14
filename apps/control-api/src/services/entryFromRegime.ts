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

/** Robot trend horizon — 10s scalp, not a 20-minute swing. */
export const TREND_LOOKBACK_MINUTES = 3;
export const TREND_LOOKBACK_10S = TREND_LOOKBACK_MINUTES * 6;

function movingOrNull(bar: TenSecBar): boolean {
  return isMoving10s(bar);
}

/** Softer than before — Gold 10s often moves ~0.3–1.0 pts (~0.007–0.02%). */
function dip(bar: TenSecBar): boolean {
  return bodyPct(bar) <= -0.00005 || (bar.close < bar.open && rangePct(bar) >= 0.00008);
}

function rally(bar: TenSecBar): boolean {
  return bodyPct(bar) >= 0.00005 || (bar.close > bar.open && rangePct(bar) >= 0.00008);
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

/** Bias from recent 10s bars — last 3 minutes only. */
export function trendBiasFromBars(bars: TenSecBar[]): TrendBias {
  const w = bars.filter((b) => b && Number.isFinite(b.close)).slice(-TREND_LOOKBACK_10S);
  if (w.length < 3) return 'FLAT';
  const bodies = w.map(bodyPct);
  const upN = bodies.filter((v) => v > 0.00004).length;
  const downN = bodies.filter((v) => v < -0.00004).length;
  const { net, persist } = netAndPersist(w[0]!.open, w[w.length - 1]!.close, upN, downN, w.length);
  const last = w[w.length - 1]!;
  // A green continuation with non-negative net is a climb — never call it DOWN.
  if (bodyPct(last) > 0.00004 && net >= 0) return 'UP';
  if (bodyPct(last) < -0.00004 && net <= 0) return 'DOWN';
  if (net > 0.0002 && persist >= 0) return 'UP';
  if (net < -0.0002 && persist <= 0) return 'DOWN';
  if (net > 0.0004) return 'UP';
  if (net < -0.0004) return 'DOWN';
  if (persist > 0.2 && net > 0) return 'UP';
  if (persist < -0.2 && net < 0) return 'DOWN';
  // Last bar paints the short bias when net is muddled — kills FLAT deadlock.
  if (dip(last) && persist <= 0) return 'DOWN';
  if (rally(last) && persist >= 0) return 'UP';
  return 'FLAT';
}

/** Climb/dump from the last 3 one-minute candles only. */
export function trendBiasFromMinuteCandles(
  candles: Array<{ open: number; close: number }>
): TrendBias {
  const w = candles
    .filter((c) => c && Number.isFinite(c.open) && Number.isFinite(c.close))
    .slice(-TREND_LOOKBACK_MINUTES);
  if (w.length < 2) return 'FLAT';
  const upN = w.filter((c) => c.close > c.open).length;
  const downN = w.filter((c) => c.close < c.open).length;
  const { net, persist } = netAndPersist(w[0]!.open, w[w.length - 1]!.close, upN, downN, w.length);
  const last = w[w.length - 1]!;
  if (last.close > last.open && net >= 0) return 'UP';
  if (last.close < last.open && net <= 0) return 'DOWN';
  if (net > 0.0005 && persist >= 0) return 'UP';
  if (net < -0.0005 && persist <= 0) return 'DOWN';
  if (net > 0.001) return 'UP';
  if (net < -0.001) return 'DOWN';
  if (persist > 0.15 && net > 0.0002) return 'UP';
  if (persist < -0.15 && net < -0.0002) return 'DOWN';
  if (last.close < last.open) return 'DOWN';
  if (last.close > last.open) return 'UP';
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

/** Regime carries direction when bias calculator is still FLAT. */
export function effectiveBias(
  regime: string | null | undefined,
  bias: TrendBias,
  bar?: TenSecBar | null
): TrendBias {
  if (bias === 'UP' || bias === 'DOWN') return bias;
  const r = normalizeRegime(regime);
  if (r === 'TREND_UP' || r === 'PULLBACK_UPTREND' || r === 'BREAKOUT_UP') return 'UP';
  if (r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND' || r === 'BREAKOUT_DOWN') return 'DOWN';
  if (bar) {
    if (dip(bar)) return 'DOWN';
    if (rally(bar)) return 'UP';
  }
  return 'FLAT';
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
    if (direction === 'SELL' && net > 0.0003) return 'no SELL, 10s net still up';
    if (direction === 'BUY' && net < -0.0003) return 'no BUY, 10s net still down';
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

  const largeUp = prevBody >= 0.0005 || priorNet >= 0.001;
  const largeDown = prevBody <= -0.0005 || priorNet <= -0.001;

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

/** Last 3×1m: opposite close after a short burst — enough confirmation to fade. */
export function minuteExhaustionConfirmed(
  direction: 'BUY' | 'SELL',
  candles: Array<{ open: number; close: number }>
): boolean {
  const w = candles
    .filter((c) => c && Number.isFinite(c.open) && Number.isFinite(c.close))
    .slice(-TREND_LOOKBACK_MINUTES);
  if (w.length < 3) return false;
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

function gate(
  hit: RegimeEntry | null,
  bias: TrendBias,
  bar: TenSecBar,
  regime?: string | null
): RegimeEntry | null {
  if (!hit) return null;
  const b = effectiveBias(regime, bias, bar);
  const deny = denyWithTrendEntry(hit.direction, bar, b);
  if (deny) return null;
  return { ...hit, reason: `${hit.reason} · bias ${b}` };
}

/**
 * Suitable entry for the current 10s regime. Returns null = WAIT.
 * With-trend only: never fade RANGE, never sell a climb, never buy a dump.
 * UNKNOWN / FLAT no longer hard-block — regime or bar implies direction.
 */
export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null,
  bias: TrendBias = 'FLAT',
  recent?: TenSecBar[] | null
): RegimeEntry | null {
  const exhaustion = decideExhaustionEntry(withBar(recent, bar));
  if (exhaustion) {
    const b = effectiveBias(regime, bias, bar);
    return { ...exhaustion, reason: `${exhaustion.reason} · bias ${b}` };
  }

  const r: RegimeName = normalizeRegime(regime);
  const b = effectiveBias(r, bias, bar);
  const candle = describe(bar);

  // UNKNOWN / COMPRESSION / TRANSITION — unlocked by effective bias (regime or bar).
  if (r === 'UNKNOWN' || r === 'TRANSITION' || r === 'COMPRESSION') {
    if (b === 'UP' && movingOrNull(bar) && dip(bar)) {
      return gate(
        { direction: 'BUY', setup: 'PULLBACK', reason: `${r}+bias UP dip-buy · ${candle}` },
        b,
        bar,
        r
      );
    }
    if (b === 'UP' && movingOrNull(bar) && rally(bar)) {
      return gate(
        { direction: 'BUY', setup: 'BREAKOUT', reason: `${r}+bias UP follow · ${candle}` },
        b,
        bar,
        r
      );
    }
    if (b === 'DOWN' && movingOrNull(bar) && dip(bar)) {
      return gate(
        { direction: 'SELL', setup: 'PULLBACK', reason: `${r}+bias DOWN follow dump · ${candle}` },
        b,
        bar,
        r
      );
    }
    return null;
  }

  // Countertrend-by-definition regimes — WAIT (no fade hunt).
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
    return gate({ direction: 'BUY', setup: 'PULLBACK', reason: `${r} dip-buy · ${candle}` }, b, bar, r);
  }
  if (r === 'TREND_DOWN') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return gate(
      { direction: 'SELL', setup: 'PULLBACK', reason: `${r} follow dump · ${candle}` },
      b,
      bar,
      r
    );
  }

  if (r === 'PULLBACK_UPTREND') {
    if (!movingOrNull(bar) || !rally(bar)) return null;
    return gate(
      { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} resume long · ${candle}` },
      b,
      bar,
      r
    );
  }
  if (r === 'PULLBACK_DOWNTREND') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return gate(
      { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} resume short · ${candle}` },
      b,
      bar,
      r
    );
  }

  if (r === 'BREAKOUT_UP') {
    if (!movingOrNull(bar) || dip(bar) || !rally(bar)) return null;
    return gate({ direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` }, b, bar, r);
  }
  if (r === 'BREAKOUT_DOWN') {
    if (!movingOrNull(bar) || rally(bar) || !dip(bar)) return null;
    return gate({ direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` }, b, bar, r);
  }

  if (r === 'EXPANSION') {
    if (!movingOrNull(bar) || b === 'FLAT') return null;
    if (rally(bar)) {
      return gate({ direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow up · ${candle}` }, b, bar, r);
    }
    if (dip(bar)) {
      return gate(
        { direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow down · ${candle}` },
        b,
        bar,
        r
      );
    }
    return null;
  }

  return null;
}
