/** VS MASTER analysis — ported heuristics from VS_READER_ENGINE_V2 (wired, measurable scores). */
import type { AnalysisSnapshot, Bar, MarketRegime } from './types.js';

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function mean(xs: number[]) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function atr(bars: Bar[], n = 14): number {
  if (bars.length < 2) return 0;
  const slice = bars.slice(-Math.min(n + 1, bars.length));
  const trs: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i]!;
    const p = slice[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (!trs.length) return 0;
  // Drop micro TRs from mixed-timeframe pollution (10s onto 1m/5m structure)
  const sorted = [...trs].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const usable =
    med > 1e-9 ? trs.filter((t) => t >= med * 0.15) : trs.filter((t) => t > 0);
  return mean(usable.length ? usable : trs);
}

/** Simple EMA — VS-System EMA3 trail uses period 3 on closes. */
export function ema(values: number[], period: number): number | null {
  if (!(period >= 1) || values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` samples (standard)
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i]!;
  e /= period;
  for (let i = period; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k);
  }
  return e;
}

/** EMA of bar closes — null when insufficient history. */
export function emaFromBars(bars: Bar[], period = 3): number | null {
  const closes = bars
    .map((b) => b.close)
    .filter((c) => Number.isFinite(c) && c > 0);
  return ema(closes, period);
}

/** Price side vs EMA3 — VS-System EMA_TICK edge detect. */
export function ema3PriceSide(
  mark: number,
  ema3: number
): 'above' | 'below' | null {
  if (!(mark > 0) || !Number.isFinite(mark) || !(ema3 > 0) || !Number.isFinite(ema3)) {
    return null;
  }
  return mark >= ema3 ? 'above' : 'below';
}

/**
 * VS-System EMA_TICK price-through exit: opposite edge through EMA3.
 * Requires a prior side so the first tick after open/restart does not false-exit.
 */
export function ema3PriceThroughExit(input: {
  side: 'BUY' | 'SELL';
  mark: number;
  ema3: number;
  prevSide: 'above' | 'below' | null | undefined;
}): { exit: boolean; reason: string } {
  const sideNow = ema3PriceSide(input.mark, input.ema3);
  const prev = input.prevSide ?? null;
  if (!sideNow || !prev) return { exit: false, reason: '' };
  if (input.side === 'BUY' && prev === 'above' && sideNow === 'below') {
    return { exit: true, reason: 'EMA3_PRICE_THROUGH' };
  }
  if (input.side === 'SELL' && prev === 'below' && sideNow === 'above') {
    return { exit: true, reason: 'EMA3_PRICE_THROUGH' };
  }
  return { exit: false, reason: '' };
}

/** Current + previous (+ optional prev2) EMA of closes. */
export function emaPairFromBars(
  bars: Bar[],
  period: number
): { cur: number; prev: number; prev2: number | null } | null {
  if (!(period >= 1)) return null;
  const closes = bars
    .map((b) => b.close)
    .filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < period + 1) return null;
  const cur = ema(closes, period);
  const prev = ema(closes.slice(0, -1), period);
  if (cur == null || prev == null) return null;
  const prev2 =
    closes.length >= period + 2 ? ema(closes.slice(0, -2), period) : null;
  return { cur, prev, prev2: prev2 != null && Number.isFinite(prev2) ? prev2 : null };
}

/**
 * VS-System forming Close[0]: last bar still open when ts_ms is within barMs of now.
 * Missing ts → treat as forming so live mid replaces the tip (safe for LiveBarBuilder).
 */
export function isFormingBar(
  bar: Bar | undefined,
  nowMs = Date.now(),
  barMs = 10_000
): boolean {
  if (!bar) return true;
  const ts = bar.ts_ms;
  if (ts == null || !Number.isFinite(ts)) return true;
  const age = nowMs - ts;
  return age >= 0 && age < barMs;
}

/**
 * VS-System closesWithLiveClose0 — replace forming tip with live mid, or append Close[0]
 * when the last historical bar is already closed.
 */
export function closesWithLiveClose0(
  bars: Bar[],
  liveMid: number,
  nowMs = Date.now(),
  barMs = 10_000
): number[] {
  const closes = bars
    .map((b) => b.close)
    .filter((c) => Number.isFinite(c) && c > 0);
  if (!Number.isFinite(liveMid) || liveMid <= 0) return closes;
  if (closes.length === 0) return [liveMid];
  const last = bars[bars.length - 1];
  if (isFormingBar(last, nowMs, barMs)) {
    return [...closes.slice(0, -1), liveMid];
  }
  return [...closes, liveMid];
}

export type EmaTickLive = {
  ema1: number;
  ema3: number | null;
  /** Prior closed-bar EMA1 (never from previous live tick — anti-chop). */
  ema1Prev: number | null;
  ema3Prev: number | null;
  ema1Prev2: number | null;
  ema3Prev2: number | null;
};

/**
 * VS-System applyEmaTickLivePrice: EMA1 ≈ live mid; EMA3 from Close[0]=mid series;
 * prev/prev2 stay on closed bars only.
 */
export function emaTickLiveFromBars(
  bars: Bar[],
  liveMid: number,
  nowMs = Date.now(),
  barMs = 10_000
): EmaTickLive | null {
  if (!Number.isFinite(liveMid) || liveMid <= 0) return null;
  const series = closesWithLiveClose0(bars, liveMid, nowMs, barMs);
  if (series.length < 1) return null;
  const closedOnly = isFormingBar(bars[bars.length - 1], nowMs, barMs)
    ? series.slice(0, -1)
    : bars
        .map((b) => b.close)
        .filter((c) => Number.isFinite(c) && c > 0);
  const ema3Live = series.length >= 3 ? ema(series, 3) : null;
  const ema1Prev =
    closedOnly.length >= 1 ? ema(closedOnly, 1) : null;
  const ema3Prev =
    closedOnly.length >= 3 ? ema(closedOnly, 3) : null;
  const ema1Prev2 =
    closedOnly.length >= 2 ? ema(closedOnly.slice(0, -1), 1) : null;
  const ema3Prev2 =
    closedOnly.length >= 4 ? ema(closedOnly.slice(0, -1), 3) : null;
  return {
    ema1: liveMid,
    ema3: ema3Live != null && Number.isFinite(ema3Live) ? ema3Live : null,
    ema1Prev: ema1Prev != null && Number.isFinite(ema1Prev) ? ema1Prev : null,
    ema3Prev: ema3Prev != null && Number.isFinite(ema3Prev) ? ema3Prev : null,
    ema1Prev2: ema1Prev2 != null && Number.isFinite(ema1Prev2) ? ema1Prev2 : null,
    ema3Prev2: ema3Prev2 != null && Number.isFinite(ema3Prev2) ? ema3Prev2 : null,
  };
}

/**
 * VS-System EMA_TICK structural EMA1×EMA3 cross exit (forming + last-closed).
 */
export function ema13CrossExit(input: {
  side: 'BUY' | 'SELL';
  ema1: number;
  ema3: number;
  ema1Prev: number;
  ema3Prev: number;
  /** Optional: EMA on closes[:-2] for closed-bar cross window */
  ema1Prev2?: number | null;
  ema3Prev2?: number | null;
}): { exit: boolean; reason: string } {
  const { ema1, ema3, ema1Prev, ema3Prev } = input;
  if (![ema1, ema3, ema1Prev, ema3Prev].every((n) => Number.isFinite(n))) {
    return { exit: false, reason: '' };
  }
  const structCrossUp = ema1Prev <= ema3Prev && ema1 > ema3;
  const structCrossDown = ema1Prev >= ema3Prev && ema1 < ema3;
  const p2ok =
    input.ema1Prev2 != null &&
    input.ema3Prev2 != null &&
    Number.isFinite(input.ema1Prev2) &&
    Number.isFinite(input.ema3Prev2);
  const closedCrossUp =
    p2ok &&
    input.ema1Prev2! <= input.ema3Prev2! &&
    ema1Prev > ema3Prev;
  const closedCrossDown =
    p2ok &&
    input.ema1Prev2! >= input.ema3Prev2! &&
    ema1Prev < ema3Prev;
  if (input.side === 'BUY' && (structCrossDown || closedCrossDown)) {
    return { exit: true, reason: 'EMA13_CROSS_DOWN' };
  }
  if (input.side === 'SELL' && (structCrossUp || closedCrossUp)) {
    return { exit: true, reason: 'EMA13_CROSS_UP' };
  }
  return { exit: false, reason: '' };
}

/**
 * VS-System EMA_TICK fresh-cross ENTRY — struct/closed cross + divergence + price side.
 */
export function ema13FreshEntry(input: {
  side: 'BUY' | 'SELL';
  price: number;
  ema1: number;
  ema3: number;
  ema1Prev: number;
  ema3Prev: number;
  ema1Prev2?: number | null;
  ema3Prev2?: number | null;
}): { ok: boolean; gate: string } {
  const { ema1, ema3, ema1Prev, ema3Prev, price } = input;
  if (![ema1, ema3, ema1Prev, ema3Prev, price].every((n) => Number.isFinite(n))) {
    return { ok: false, gate: 'ema13_wait_cross' };
  }
  const gap = Math.abs(ema1 - ema3);
  const gapPrev = Math.abs(ema1Prev - ema3Prev);
  const diverging = gap > gapPrev;
  const structCrossUp = ema1Prev <= ema3Prev && ema1 > ema3;
  const structCrossDown = ema1Prev >= ema3Prev && ema1 < ema3;
  const p2ok =
    input.ema1Prev2 != null &&
    input.ema3Prev2 != null &&
    Number.isFinite(input.ema1Prev2) &&
    Number.isFinite(input.ema3Prev2);
  const closedCrossUp =
    p2ok && input.ema1Prev2! <= input.ema3Prev2! && ema1Prev > ema3Prev;
  const closedCrossDown =
    p2ok && input.ema1Prev2! >= input.ema3Prev2! && ema1Prev < ema3Prev;

  if (input.side === 'BUY') {
    const fresh =
      (structCrossUp || closedCrossUp) && diverging && price > ema3;
    return fresh
      ? { ok: true, gate: 'ema13_cross_up' }
      : { ok: false, gate: 'ema13_wait_fresh_cross' };
  }
  const fresh =
    (structCrossDown || closedCrossDown) && diverging && price < ema3;
  return fresh
    ? { ok: true, gate: 'ema13_cross_down' }
    : { ok: false, gate: 'ema13_wait_fresh_cross' };
}

export function analyzeBars(bars: Bar[], spread = 0, nowMs = Date.now()): AnalysisSnapshot {
  if (bars.length < 5) {
    return {
      regime: 'UNKNOWN',
      market_state: 'insufficient_bars',
      momentum_score: 0,
      momentum_dir: 'NEUTRAL',
      trend_dir: 'SIDEWAYS',
      trend_strength: 0,
      structure_bias: 'NEUTRAL',
      swing_high: bars.at(-1)?.high ?? 0,
      swing_low: bars.at(-1)?.low ?? 0,
      buy_pressure: 0.5,
      sell_pressure: 0.5,
      behavior_bull: 0.5,
      behavior_bear: 0.5,
      impact_score: 0,
      context_quality: 0.2,
      volatility: 0,
      atr: 0,
      data_quality: 0.2,
      session: sessionLabel(nowMs),
    };
  }

  const window = bars.slice(-Math.min(30, bars.length));
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const prev = window[window.length - 2]!;
  const roc = first.close !== 0 ? (last.close - first.close) / first.close : 0;
  const momentum_score = clamp(roc * 10, -1, 1);
  const momentum_dir =
    momentum_score > 0.05 ? 'UP' : momentum_score < -0.05 ? 'DOWN' : 'NEUTRAL';

  const highs = window.map((b) => b.high);
  const lows = window.map((b) => b.low);
  const higher_highs = highs.every((h, i) => i === 0 || h >= highs[i - 1]! - 1e-9);
  const lower_lows = lows.every((l, i) => i === 0 || l <= lows[i - 1]! + 1e-9);
  let trend_dir: AnalysisSnapshot['trend_dir'] = 'SIDEWAYS';
  let trend_strength = Math.abs(momentum_score);
  if (higher_highs && momentum_score > 0) {
    trend_dir = 'UP';
    trend_strength = clamp(trend_strength + 0.2, 0, 1);
  } else if (lower_lows && momentum_score < 0) {
    trend_dir = 'DOWN';
    trend_strength = clamp(trend_strength + 0.2, 0, 1);
  }

  const swing_high = Math.max(...highs);
  const swing_low = Math.min(...lows);
  const mid = (swing_high + swing_low) / 2;
  let structure_bias: AnalysisSnapshot['structure_bias'] = 'NEUTRAL';
  if (last.close > mid + (swing_high - swing_low) * 0.1) structure_bias = 'BULLISH';
  else if (last.close < mid - (swing_high - swing_low) * 0.1) structure_bias = 'BEARISH';

  let buyBodies = 0;
  let sellBodies = 0;
  let bullPat = 0;
  let bearPat = 0;
  for (const b of window.slice(-8)) {
    const body = b.close - b.open;
    const range = Math.max(b.high - b.low, 1e-9);
    if (body > 0) {
      buyBodies += body / range;
      if (body / range > 0.55) bullPat += 1;
    } else if (body < 0) {
      sellBodies += -body / range;
      if (-body / range > 0.55) bearPat += 1;
    }
  }
  // Flat / zero-body window → unknown pressure (0.5), NOT anti-edge zeros
  let buy_pressure: number;
  let sell_pressure: number;
  if (buyBodies + sellBodies < 1e-12) {
    buy_pressure = 0.5;
    sell_pressure = 0.5;
  } else {
    const pressSum = buyBodies + sellBodies;
    buy_pressure = buyBodies / pressSum;
    sell_pressure = sellBodies / pressSum;
  }
  const behavior_bull = clamp(bullPat / 8, 0, 1);
  const behavior_bear = clamp(bearPat / 8, 0, 1);

  const atrVal = atr(window);
  const volatility = last.close > 0 ? atrVal / last.close : 0;
  const impact_score = clamp(
    (Math.abs(momentum_score) + trend_strength + Math.abs(buy_pressure - sell_pressure)) / 3,
    0,
    1
  );

  const spreadPct = last.close > 0 ? spread / last.close : 0;
  const data_quality = clamp(
    1 - spreadPct * 200 - (bars.length < 20 ? 0.3 : 0),
    0.05,
    1
  );
  const hour = new Date(nowMs).getUTCHours();
  const session = sessionLabel(nowMs);
  const context_quality = clamp(
    data_quality * (hour >= 7 && hour <= 20 ? 1 : 0.7),
    0.05,
    1
  );

  const regime = classifyRegime({
    trend_dir,
    trend_strength,
    volatility,
    structure_bias,
    last,
    swing_high,
    swing_low,
    data_quality,
  });

  return {
    regime,
    market_state: `${regime}:${trend_dir}:${structure_bias}`,
    momentum_score,
    momentum_dir,
    trend_dir,
    trend_strength,
    structure_bias,
    swing_high,
    swing_low,
    buy_pressure,
    sell_pressure,
    behavior_bull,
    behavior_bear,
    impact_score,
    context_quality,
    volatility,
    atr: atrVal,
    data_quality,
    session,
  };
}

function sessionLabel(nowMs: number): string {
  const h = new Date(nowMs).getUTCHours();
  if (h >= 0 && h < 7) return 'ASIA';
  if (h >= 7 && h < 12) return 'LONDON';
  if (h >= 12 && h < 17) return 'NY_OVERLAP';
  if (h >= 17 && h < 21) return 'NY';
  return 'OFF_HOURS';
}

function classifyRegime(input: {
  trend_dir: AnalysisSnapshot['trend_dir'];
  trend_strength: number;
  volatility: number;
  structure_bias: AnalysisSnapshot['structure_bias'];
  last: Bar;
  swing_high: number;
  swing_low: number;
  data_quality: number;
}): MarketRegime {
  if (input.data_quality < 0.35) return 'UNSTABLE';
  if (input.volatility > 0.004) return 'HIGH_VOLATILITY';
  if (input.volatility < 0.0004) return 'LOW_VOLATILITY';
  const span = input.swing_high - input.swing_low;
  const broke =
    input.last.close > input.swing_high - span * 0.02 ||
    input.last.close < input.swing_low + span * 0.02;
  // Directional labels match desk RegimeName so BestOutcome ThesisFailure can fire.
  if (broke && input.trend_strength > 0.45) {
    const down =
      input.trend_dir === 'DOWN' || input.structure_bias === 'BEARISH';
    return down ? 'BREAKOUT_DOWN' : 'BREAKOUT_UP';
  }
  if (input.trend_dir !== 'SIDEWAYS' && input.trend_strength >= 0.35) {
    return input.trend_dir === 'DOWN' ? 'TREND_DOWN' : 'TREND_UP';
  }
  if (input.trend_strength < 0.2) return 'RANGE';
  return 'UNKNOWN';
}
