/**
 * Strategy engine façade — eligibility only; never auto-trades from regime alone.
 * A regime is NOT an order. TREND_UP ≠ BUY.
 */

import type { RegimeId } from '../../regime/src/classifier.js';

export type StrategyId =
  | 'trendContinuation'
  | 'trendPullback'
  | 'rangeMeanReversion'
  | 'breakoutContinuation'
  | 'breakoutRetest'
  | 'reversalConfirmation'
  | 'noTrade';

export type StrategySpec = {
  id: StrategyId;
  version: string;
  allowedRegimes: RegimeId[];
  forbiddenRegimes: RegimeId[];
  requiredTimeframes: string[];
  minConfidence: number;
};

export const STRATEGY_REGISTRY: StrategySpec[] = [
  {
    id: 'trendContinuation',
    version: '1',
    allowedRegimes: ['TREND_UP', 'TREND_DOWN'],
    forbiddenRegimes: [
      'NO_TRADE',
      'STALE_MARKET',
      'ABNORMAL_SPREAD',
      'LIQUIDITY_RISK',
      'UNSTABLE_MARKET',
    ],
    requiredTimeframes: ['M15', 'H1'],
    minConfidence: 0.55,
  },
  {
    id: 'trendPullback',
    version: '1',
    allowedRegimes: ['TREND_UP', 'TREND_DOWN'],
    forbiddenRegimes: ['NO_TRADE', 'STALE_MARKET', 'VOLATILITY_EXPANSION', 'ABNORMAL_SPREAD'],
    requiredTimeframes: ['M5', 'M15'],
    minConfidence: 0.55,
  },
  {
    id: 'rangeMeanReversion',
    version: '1',
    allowedRegimes: ['RANGE', 'VOLATILITY_COMPRESSION'],
    forbiddenRegimes: ['NO_TRADE', 'STALE_MARKET', 'VOLATILITY_EXPANSION', 'BREAKOUT_UP_CONFIRMED', 'BREAKOUT_DOWN_CONFIRMED'],
    requiredTimeframes: ['M15', 'H1'],
    minConfidence: 0.5,
  },
  {
    id: 'breakoutContinuation',
    version: '1',
    allowedRegimes: ['BREAKOUT_UP_CONFIRMED', 'BREAKOUT_DOWN_CONFIRMED'],
    forbiddenRegimes: ['NO_TRADE', 'STALE_MARKET', 'BREAKOUT_UP_FAILED', 'BREAKOUT_DOWN_FAILED'],
    requiredTimeframes: ['M5', 'M15'],
    minConfidence: 0.6,
  },
  {
    id: 'breakoutRetest',
    version: '1',
    allowedRegimes: [
      'BREAKOUT_UP_CANDIDATE',
      'BREAKOUT_DOWN_CANDIDATE',
      'BREAKOUT_UP_CONFIRMED',
      'BREAKOUT_DOWN_CONFIRMED',
    ],
    forbiddenRegimes: ['NO_TRADE', 'STALE_MARKET', 'ABNORMAL_SPREAD'],
    requiredTimeframes: ['M5', 'M15'],
    minConfidence: 0.55,
  },
  {
    id: 'reversalConfirmation',
    version: '1',
    allowedRegimes: ['REVERSAL_BULLISH_CANDIDATE', 'REVERSAL_BEARISH_CANDIDATE'],
    forbiddenRegimes: ['NO_TRADE', 'STALE_MARKET', 'LIQUIDITY_RISK'],
    requiredTimeframes: ['M15', 'H1'],
    minConfidence: 0.6,
  },
  {
    id: 'noTrade',
    version: '1',
    allowedRegimes: [
      'NO_TRADE',
      'STALE_MARKET',
      'UNSTABLE_MARKET',
      'LIQUIDITY_RISK',
      'ABNORMAL_SPREAD',
    ],
    forbiddenRegimes: [],
    requiredTimeframes: ['M1'],
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

export function getStrategy(id: StrategyId): StrategySpec | undefined {
  return STRATEGY_REGISTRY.find((s) => s.id === id);
}
