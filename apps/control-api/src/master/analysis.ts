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
  return mean(trs);
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
  if (broke && input.trend_strength > 0.45) return 'BREAKOUT';
  if (input.trend_dir !== 'SIDEWAYS' && input.trend_strength >= 0.35) return 'TREND';
  if (input.trend_strength < 0.2) return 'RANGE';
  return 'UNKNOWN';
}
