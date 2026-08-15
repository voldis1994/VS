/**
 * 10s OHLC + regime-as-CONTEXT entry.
 * Regime selects/reweights setup families — it does NOT grant or deny permission to trade.
 * NO_SETUP = no valid setup evidence found (never "regime forbidden").
 */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { bodyPct, isMoving10s, rangePct, type TenSecBar } from './tenSecondOhlc.js';

export type SetupType =
  | 'CONTINUATION'
  | 'PULLBACK'
  | 'BREAKOUT'
  | 'FAILED_BREAKOUT'
  | 'RANGE_REJECTION'
  | 'FADE'
  | 'REVERSAL';

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: SetupType;
  reason: string;
  /** Confirmed exhaustion/reversal — may be counter-trend by design */
  exhaustion?: boolean;
  /** Setup family allows counter-trend (FADE / range rejection / failed breakout / reversal) */
  allow_countertrend?: boolean;
};

export type TrendBias = 'UP' | 'DOWN' | 'FLAT';

/** Robot trend horizon — 10s scalp, not a 20-minute swing. */
export const TREND_LOOKBACK_MINUTES = 3;
export const TREND_LOOKBACK_10S = TREND_LOOKBACK_MINUTES * 6;

function movingOrNull(bar: TenSecBar): boolean {
  return isMoving10s(bar);
}

/** Softer than before — Gold 10s often moves ~0.1–1.0 pts (~0.002–0.02%). */
function dip(bar: TenSecBar): boolean {
  return bodyPct(bar) <= -0.00003 || (bar.close < bar.open && rangePct(bar) >= 0.00004);
}

function rally(bar: TenSecBar): boolean {
  return bodyPct(bar) >= 0.00003 || (bar.close > bar.open && rangePct(bar) >= 0.00004);
}

/** Any red/green close — COMPRESSION is quiet by definition; hard isMoving would deadlock IN=0. */
function softDip(bar: TenSecBar): boolean {
  return bar.close < bar.open || bodyPct(bar) <= -0.00002;
}

function softRally(bar: TenSecBar): boolean {
  return bar.close > bar.open || bodyPct(bar) >= 0.00002;
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
  if (bodyPct(last) > 0.00004 && net >= 0) return 'UP';
  if (bodyPct(last) < -0.00004 && net <= 0) return 'DOWN';
  if (net > 0.0002 && persist >= 0) return 'UP';
  if (net < -0.0002 && persist <= 0) return 'DOWN';
  if (net > 0.0004) return 'UP';
  if (net < -0.0004) return 'DOWN';
  if (persist > 0.2 && net > 0) return 'UP';
  if (persist < -0.2 && net < 0) return 'DOWN';
  if (dip(last) && persist <= 0) return 'DOWN';
  if (rally(last) && persist >= 0) return 'UP';
  return 'FLAT';
}

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

/** Regime carries direction when bias calculator is still FLAT — does NOT rewrite regime. */
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

export function isCountertrendSide(direction: 'BUY' | 'SELL', bias: TrendBias): boolean {
  return !allowsBias(direction, bias);
}

/**
 * With-trend veto. When opts.exhaustion / allowCountertrend: skip counter-trend + net vetoes
 * (confirmed FADE/reversal/range rejection may be counter-trend by design).
 * Still never SELL a green impulse bar / BUY a red impulse without UP (unless exhaustion BUY confirm).
 */
export function denyWithTrendEntry(
  direction: 'BUY' | 'SELL',
  bar: TenSecBar | null | undefined,
  bias: TrendBias,
  recent?: TenSecBar[] | null,
  opts?: { exhaustion?: boolean; allowCountertrend?: boolean }
): string | null {
  const ctOk = Boolean(opts?.exhaustion || opts?.allowCountertrend);
  if (bar && Number.isFinite(bar.open) && Number.isFinite(bar.close)) {
    if (direction === 'SELL' && rally(bar) && !ctOk) {
      return 'no SELL on green 10s (would sell the climb)';
    }
    // FADE SELL confirm is a red bar — OK. FADE BUY confirm is green after dump — OK with exhaustion.
    if (direction === 'BUY' && dip(bar) && !opts?.exhaustion && bias !== 'UP') {
      return 'no BUY on red 10s without UP bias';
    }
    if (direction === 'SELL' && rally(bar) && opts?.exhaustion) {
      // Exhaustion SELL must be on rejection (red), not green
      return 'no FADE SELL on green 10s';
    }
  }
  if (ctOk) return null;
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

/** Prior-window high/low from existing OHLC — range edges without inventing new thresholds. */
export function rangeBoundsFromBars(
  bars: TenSecBar[]
): { hi: number; lo: number; span: number } | null {
  const prior = bars.filter((b) => b && Number.isFinite(b.close)).slice(0, -1).slice(-8);
  if (prior.length < 3) return null;
  const hi = Math.max(...prior.map((b) => b.high));
  const lo = Math.min(...prior.map((b) => b.low));
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return null;
  return { hi, lo, span };
}

function nearUpper(bar: TenSecBar, bounds: { hi: number; lo: number; span: number }): boolean {
  return bar.high >= bounds.hi - bounds.span * 0.2 || bar.close >= bounds.hi - bounds.span * 0.25;
}

function nearLower(bar: TenSecBar, bounds: { hi: number; lo: number; span: number }): boolean {
  return bar.low <= bounds.lo + bounds.span * 0.2 || bar.close <= bounds.lo + bounds.span * 0.25;
}

/**
 * SELL/BUY after a large move — only with confirmation on the NEXT closed 10s.
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

  if (largeUp && priorNet > 0 && dip(cur) && cur.close < prev.close) {
    return {
      direction: 'SELL',
      setup: 'FADE',
      exhaustion: true,
      allow_countertrend: true,
      reason: `EXHAUSTION confirm after large up · prev body=${(prevBody * 100).toFixed(3)}% priorNet=${(priorNet * 100).toFixed(3)}% · ${describe(cur)}`,
    };
  }
  if (largeDown && priorNet < 0 && rally(cur) && cur.close > prev.close) {
    return {
      direction: 'BUY',
      setup: 'FADE',
      exhaustion: true,
      allow_countertrend: true,
      reason: `EXHAUSTION confirm after large down · prev body=${(prevBody * 100).toFixed(3)}% priorNet=${(priorNet * 100).toFixed(3)}% · ${describe(cur)}`,
    };
  }
  return null;
}

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

/** RANGE setup family: rejection at measured prior-window edges (existing OHLC only). */
export function decideRangeRejection(
  bar: TenSecBar,
  recent: TenSecBar[] | null | undefined
): RegimeEntry | null {
  const bars = withBar(recent, bar);
  const bounds = rangeBoundsFromBars(bars);
  if (!bounds) return null;
  // Insufficient edge structure — do not invent precision
  if (bounds.span / Math.max(Math.abs(bounds.hi), 1e-9) < 0.00015) return null;

  if (nearUpper(bar, bounds) && dip(bar) && bar.close < bar.open && movingOrNull(bar)) {
    return {
      direction: 'SELL',
      setup: 'RANGE_REJECTION',
      allow_countertrend: true,
      reason: `RANGE_REJECTION at upper edge H=${bounds.hi.toFixed(2)} · ${describe(bar)}`,
    };
  }
  if (nearLower(bar, bounds) && rally(bar) && bar.close > bar.open && movingOrNull(bar)) {
    return {
      direction: 'BUY',
      setup: 'RANGE_REJECTION',
      allow_countertrend: true,
      reason: `RANGE_REJECTION at lower edge L=${bounds.lo.toFixed(2)} · ${describe(bar)}`,
    };
  }
  return null;
}

/** FAILED_BREAKOUT_* — candidate only; require return-into-range confirmation on closed bar. */
export function decideFailedBreakout(
  bar: TenSecBar,
  regime: RegimeName,
  recent: TenSecBar[] | null | undefined
): RegimeEntry | null {
  const bars = withBar(recent, bar);
  const bounds = rangeBoundsFromBars(bars);
  if (!bounds) return null;

  if (regime === 'FAILED_BREAKOUT_UP') {
    // Failed upside: rejection back into/below prior high
    if (dip(bar) && movingOrNull(bar) && bar.close <= bounds.hi && bar.close < bar.open) {
      return {
        direction: 'SELL',
        setup: 'FAILED_BREAKOUT',
        allow_countertrend: true,
        reason: `FAILED_BREAKOUT_UP confirmed · back ≤ H=${bounds.hi.toFixed(2)} · ${describe(bar)}`,
      };
    }
    return null;
  }
  if (regime === 'FAILED_BREAKOUT_DOWN') {
    if (rally(bar) && movingOrNull(bar) && bar.close >= bounds.lo && bar.close > bar.open) {
      return {
        direction: 'BUY',
        setup: 'FAILED_BREAKOUT',
        allow_countertrend: true,
        reason: `FAILED_BREAKOUT_DOWN confirmed · back ≥ L=${bounds.lo.toFixed(2)} · ${describe(bar)}`,
      };
    }
    return null;
  }
  return null;
}

/** REVERSAL_CANDIDATE — candidate only; require opposite confirm after directional prior. */
export function decideReversalConfirm(
  bar: TenSecBar,
  recent: TenSecBar[] | null | undefined
): RegimeEntry | null {
  const w = withBar(recent, bar);
  if (w.length < 4) return null;
  const prior = w.slice(0, -1).slice(-6);
  const first = prior[0]!;
  const prev = prior[prior.length - 1]!;
  const priorNet = (prev.close - first.open) / Math.max(Math.abs(first.open), 1e-9);
  const bodies = prior.map(bodyPct);
  const persist =
    bodies.filter((v) => v > 0.00004).length - bodies.filter((v) => v < -0.00004).length;

  // Prior climb → confirmed SELL reversal
  if (
    priorNet > 0.0004 &&
    persist > 0 &&
    dip(bar) &&
    movingOrNull(bar) &&
    bar.close < prev.close
  ) {
    return {
      direction: 'SELL',
      setup: 'REVERSAL',
      allow_countertrend: true,
      reason: `REVERSAL confirmed after up priorNet=${(priorNet * 100).toFixed(3)}% · ${describe(bar)}`,
    };
  }
  // Prior dump → confirmed BUY reversal
  if (
    priorNet < -0.0004 &&
    persist < 0 &&
    rally(bar) &&
    movingOrNull(bar) &&
    bar.close > prev.close
  ) {
    return {
      direction: 'BUY',
      setup: 'REVERSAL',
      allow_countertrend: true,
      reason: `REVERSAL confirmed after down priorNet=${(priorNet * 100).toFixed(3)}% · ${describe(bar)}`,
    };
  }
  return null;
}

function gateWithTrend(
  hit: RegimeEntry | null,
  bias: TrendBias,
  bar: TenSecBar,
  recent: TenSecBar[] | null | undefined,
  regime?: string | null
): RegimeEntry | null {
  if (!hit) return null;
  const b = effectiveBias(regime, bias, bar);
  const deny = denyWithTrendEntry(hit.direction, bar, b, recent, {
    exhaustion: hit.exhaustion,
    allowCountertrend: hit.allow_countertrend,
  });
  if (deny) return null;
  return { ...hit, reason: `${hit.reason} · bias ${b}` };
}

/**
 * Suitable entry for the current 10s regime context.
 * Returns null = no valid setup evidence (NO_SETUP) — never "regime forbidden".
 */
export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null,
  bias: TrendBias = 'FLAT',
  recent?: TenSecBar[] | null
): RegimeEntry | null {
  const bars = withBar(recent, bar);
  const exhaustion = decideExhaustionEntry(bars);
  if (exhaustion) {
    const b = effectiveBias(regime, bias, bar);
    return { ...exhaustion, reason: `${exhaustion.reason} · bias ${b}` };
  }

  const r: RegimeName = normalizeRegime(regime);
  const b = effectiveBias(r, bias, bar);
  const candle = describe(bar);

  // --- Setup families selected by regime context (not permission) ---

  if (r === 'RANGE') {
    const rr = decideRangeRejection(bar, bars);
    if (rr) return gateWithTrend(rr, b, bar, bars, r);
    // Also allow exhaustion already handled; no with-trend invent
    return null;
  }

  if (r === 'FAILED_BREAKOUT_UP' || r === 'FAILED_BREAKOUT_DOWN') {
    const fb = decideFailedBreakout(bar, r, bars);
    if (fb) return gateWithTrend(fb, b, bar, bars, r);
    return null;
  }

  if (r === 'REVERSAL_CANDIDATE') {
    const rev = decideReversalConfirm(bar, bars);
    if (rev) return gateWithTrend(rev, b, bar, bars, r);
    return null;
  }

  // UNKNOWN / COMPRESSION / TRANSITION — use available evidence; do not invent regime
  if (r === 'UNKNOWN' || r === 'TRANSITION' || r === 'COMPRESSION') {
    if (b === 'UP' && softDip(bar)) {
      return gateWithTrend(
        { direction: 'BUY', setup: 'PULLBACK', reason: `${r}+bias UP dip-buy · ${candle}` },
        b,
        bar,
        bars,
        r
      );
    }
    if (b === 'UP' && softRally(bar)) {
      return gateWithTrend(
        { direction: 'BUY', setup: 'BREAKOUT', reason: `${r}+bias UP follow · ${candle}` },
        b,
        bar,
        bars,
        r
      );
    }
    if (b === 'DOWN' && softDip(bar)) {
      return gateWithTrend(
        { direction: 'SELL', setup: 'PULLBACK', reason: `${r}+bias DOWN follow dump · ${candle}` },
        b,
        bar,
        bars,
        r
      );
    }
    return null;
  }

  if (r === 'TREND_UP') {
    if (movingOrNull(bar) && dip(bar)) {
      return gateWithTrend(
        { direction: 'BUY', setup: 'PULLBACK', reason: `${r} dip-buy · ${candle}` },
        b,
        bar,
        bars,
        r
      );
    }
    if (movingOrNull(bar) && rally(bar)) {
      return gateWithTrend(
        { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} follow climb · ${candle}` },
        b,
        bar,
        bars,
        r
      );
    }
    return null;
  }
  if (r === 'TREND_DOWN') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return gateWithTrend(
      { direction: 'SELL', setup: 'PULLBACK', reason: `${r} follow dump · ${candle}` },
      b,
      bar,
      bars,
      r
    );
  }

  if (r === 'PULLBACK_UPTREND') {
    if (!movingOrNull(bar) || !rally(bar)) return null;
    return gateWithTrend(
      { direction: 'BUY', setup: 'CONTINUATION', reason: `${r} resume long · ${candle}` },
      b,
      bar,
      bars,
      r
    );
  }
  if (r === 'PULLBACK_DOWNTREND') {
    if (!movingOrNull(bar) || !dip(bar)) return null;
    return gateWithTrend(
      { direction: 'SELL', setup: 'CONTINUATION', reason: `${r} resume short · ${candle}` },
      b,
      bar,
      bars,
      r
    );
  }

  if (r === 'BREAKOUT_UP') {
    if (!movingOrNull(bar) || dip(bar) || !rally(bar)) return null;
    return gateWithTrend(
      { direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` },
      b,
      bar,
      bars,
      r
    );
  }
  if (r === 'BREAKOUT_DOWN') {
    if (!movingOrNull(bar) || rally(bar) || !dip(bar)) return null;
    return gateWithTrend(
      { direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow · ${candle}` },
      b,
      bar,
      bars,
      r
    );
  }

  if (r === 'EXPANSION') {
    if (!movingOrNull(bar) || b === 'FLAT') return null;
    if (rally(bar)) {
      return gateWithTrend(
        { direction: 'BUY', setup: 'BREAKOUT', reason: `${r} follow up · ${candle}` },
        b,
        bar,
        bars,
        r
      );
    }
    if (dip(bar)) {
      return gateWithTrend(
        { direction: 'SELL', setup: 'BREAKOUT', reason: `${r} follow down · ${candle}` },
        b,
        bar,
        bars,
        r
      );
    }
    return null;
  }

  return null;
}
