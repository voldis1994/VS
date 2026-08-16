/**
 * Strategy engine façade — eligibility only; never auto-trades from regime alone.
 * Delegates evaluation primitives to existing control-api strategyCore where used at runtime.
 */

import type { RegimeId } from '../../regime-engine/src/classifier.js';

export type StrategyId =
  | 'trendContinuation'
  | 'pullbackTrend'
  | 'rangeMeanReversion'
  | 'breakoutContinuation'
  | 'breakoutRetest'
  | 'reversalConfirmation'
  | 'noTrade';

export type StrategySpec = {
  id: StrategyId;
  allowedRegimes: RegimeId[];
  forbiddenRegimes: RegimeId[];
  minConfidence: number;
};

export const STRATEGY_REGISTRY: StrategySpec[] = [
  {
    id: 'trendContinuation',
    allowedRegimes: ['TREND_UP', 'TREND_DOWN'],
    forbiddenRegimes: ['NO_TRADE', 'STALE_MARKET', 'ABNORMAL_SPREAD', 'LIQUIDITY_RISK'],
    minConfidence: 0.55,
  },
  {
    id: 'rangeMeanReversion',
    allowedRegimes: ['RANGE', 'VOLATILITY_COMPRESSION'],
    forbiddenRegimes: ['NO_TRADE', 'STALE_MARKET', 'VOLATILITY_EXPANSION'],
    minConfidence: 0.5,
  },
  {
    id: 'noTrade',
    allowedRegimes: ['NO_TRADE', 'STALE_MARKET', 'UNSTABLE_MARKET', 'LIQUIDITY_RISK'],
    forbiddenRegimes: [],
    minConfidence: 0,
  },
];

export function eligibleStrategies(
  regime: RegimeId,
  confidence: number
): StrategyId[] {
  return STRATEGY_REGISTRY.filter((s) => {
    if (s.forbiddenRegimes.includes(regime)) return false;
    if (!s.allowedRegimes.includes(regime)) return false;
    if (confidence < s.minConfidence && s.id !== 'noTrade') return false;
    return true;
  }).map((s) => s.id);
}
