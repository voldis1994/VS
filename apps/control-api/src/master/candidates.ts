/** Dual BUY/SELL candidates — independent component scores (heuristic, not probability). */
import { applyMarketFilters } from './filters.js';
import type {
  AnalysisSnapshot,
  ComponentScores,
  MasterConfig,
  Quote,
  TradeCandidate,
} from './types.js';

const WEIGHTS: ComponentScores = {
  momentum: 0.18,
  trend: 0.18,
  structure: 0.16,
  pressure: 0.14,
  behavior: 0.1,
  impact: 0.12,
  context: 0.12,
};

function weighted(c: ComponentScores): number {
  let s = 0;
  let w = 0;
  for (const k of Object.keys(WEIGHTS) as (keyof ComponentScores)[]) {
    s += c[k] * WEIGHTS[k];
    w += WEIGHTS[k];
  }
  return w > 0 ? s / w : 0;
}

export function buildBuyComponents(a: AnalysisSnapshot): ComponentScores {
  const momentum = (a.momentum_score + 1) / 2;
  const trend =
    a.trend_dir === 'UP'
      ? a.trend_strength
      : a.trend_dir === 'DOWN'
        ? 1 - a.trend_strength
        : 0.5;
  const structure =
    a.structure_bias === 'BULLISH' ? 1 : a.structure_bias === 'BEARISH' ? 0 : 0.5;
  return {
    momentum,
    trend,
    structure,
    pressure: a.buy_pressure,
    behavior: a.behavior_bull,
    impact: a.impact_score,
    context: a.context_quality,
  };
}

export function buildSellComponents(a: AnalysisSnapshot): ComponentScores {
  const momentum = (1 - a.momentum_score) / 2;
  const trend =
    a.trend_dir === 'DOWN'
      ? a.trend_strength
      : a.trend_dir === 'UP'
        ? 1 - a.trend_strength
        : 0.5;
  const structure =
    a.structure_bias === 'BEARISH' ? 1 : a.structure_bias === 'BULLISH' ? 0 : 0.5;
  return {
    momentum,
    trend,
    structure,
    pressure: a.sell_pressure,
    behavior: a.behavior_bear,
    impact: a.impact_score,
    context: a.context_quality,
  };
}

export function buildCandidates(
  a: AnalysisSnapshot,
  quote: Quote,
  cfg: MasterConfig
): { buy: TradeCandidate; sell: TradeCandidate } {
  const entry = quote.mid;
  const atr = Math.max(a.atr, Math.abs(entry) * 0.0003, 0.5);
  const buffer = atr * cfg.sl_buffer_atr_mult;
  const buySl = Math.min(a.swing_low - buffer, entry - atr);
  const sellSl = Math.max(a.swing_high + buffer, entry + atr);
  const buyRisk = Math.max(entry - buySl, atr * 0.5);
  const sellRisk = Math.max(sellSl - entry, atr * 0.5);

  const buyComp = buildBuyComponents(a);
  const sellComp = buildSellComponents(a);
  const buyScore = weighted(buyComp);
  const sellScore = weighted(sellComp);

  const filter = applyMarketFilters(a, quote, cfg);

  const buy: TradeCandidate = {
    side: 'BUY',
    valid: buyScore >= cfg.min_score && filter.ok && a.regime !== 'UNSTABLE',
    score: buyScore,
    components: buyComp,
    entry,
    stop_loss: buySl,
    take_profit: entry + buyRisk * cfg.reward_ratio,
    filter_ok: filter.ok,
    filter_reason: filter.reason,
  };
  const sell: TradeCandidate = {
    side: 'SELL',
    valid: sellScore >= cfg.min_score && filter.ok && a.regime !== 'UNSTABLE',
    score: sellScore,
    components: sellComp,
    entry,
    stop_loss: sellSl,
    take_profit: entry - sellRisk * cfg.reward_ratio,
    filter_ok: filter.ok,
    filter_reason: filter.reason,
  };
  return { buy, sell };
}
