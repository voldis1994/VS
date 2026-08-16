/**
 * Setup engine — measurable PASS/FAIL conditions only.
 * Never: if (regime == X) BUY
 */

import { randomUUID } from 'crypto';
import type {
  ConditionResult,
  FeedValidationReport,
  MarketStateVector,
  OperationalBlock,
  SetupRecord,
} from './types.js';

export function evalCondition(
  name: string,
  pass: boolean,
  actual: ConditionResult['actual'],
  threshold: ConditionResult['threshold'],
  detail: string
): ConditionResult {
  return { name, status: pass ? 'PASS' : 'FAIL', actual, threshold, detail };
}

export type TrendContinuationParams = {
  minTrendStrength: number;
  minTrendQuality: number;
  minAbsDirection: number;
  maxNoise: number;
  minFeedConfidence: number;
};

export const DEFAULT_TREND_CONTINUATION: TrendContinuationParams = {
  minTrendStrength: 0.45,
  minTrendQuality: 0.35,
  minAbsDirection: 0.25,
  maxNoise: 0.75,
  minFeedConfidence: 0.5,
};

/**
 * Trend continuation setup — all conditions must PASS.
 * Returns NO_SETUP / DATA_QUALITY_BLOCK / INSUFFICIENT_DATA when blocked.
 */
export function evaluateTrendContinuationSetup(input: {
  strategy_id?: string;
  market: MarketStateVector;
  feed: Pick<FeedValidationReport, 'quality' | 'trading_price' | 'block' | 'detail'>;
  params?: Partial<TrendContinuationParams>;
  entryReference?: number | null;
  invalidationReference?: number | null;
}): SetupRecord {
  const p = { ...DEFAULT_TREND_CONTINUATION, ...input.params };
  const conditions: ConditionResult[] = [];
  let block: OperationalBlock | null = null;

  if (input.market.status === 'FEED_UNAVAILABLE') {
    block = 'FEED_UNAVAILABLE';
  } else if (input.market.status === 'INSUFFICIENT_DATA') {
    block = 'INSUFFICIENT_DATA';
  } else if (input.feed.quality === 'BLOCK' || input.feed.quality === 'INSUFFICIENT_DATA') {
    block = input.feed.block || 'DATA_QUALITY_BLOCK';
  }

  const ts = input.market.trend_strength;
  const tq = input.market.trend_quality;
  const dir = input.market.direction_score;
  const noise = input.market.noise_score;
  const feedConf = input.market.feed_confidence;

  conditions.push(
    evalCondition(
      'market_state_ok',
      input.market.status === 'OK',
      input.market.status,
      'OK',
      'market measurements available'
    )
  );
  conditions.push(
    evalCondition(
      'feed_quality_ok',
      input.feed.quality === 'OK' || input.feed.quality === 'DEGRADED',
      input.feed.quality,
      'OK|DEGRADED',
      input.feed.detail
    )
  );
  conditions.push(
    evalCondition(
      'trend_strength',
      ts != null && ts >= p.minTrendStrength,
      ts,
      p.minTrendStrength,
      'normalized trend strength'
    )
  );
  conditions.push(
    evalCondition(
      'trend_quality',
      tq != null && tq >= p.minTrendQuality,
      tq,
      p.minTrendQuality,
      'R² goodness-of-fit'
    )
  );
  conditions.push(
    evalCondition(
      'direction_magnitude',
      dir != null && Math.abs(dir) >= p.minAbsDirection,
      dir,
      p.minAbsDirection,
      'abs(direction_score)'
    )
  );
  conditions.push(
    evalCondition(
      'noise_ceiling',
      noise == null || noise <= p.maxNoise,
      noise,
      p.maxNoise,
      '1 - R² noise score'
    )
  );
  conditions.push(
    evalCondition(
      'feed_confidence',
      feedConf == null || feedConf >= p.minFeedConfidence,
      feedConf,
      p.minFeedConfidence,
      'multi-feed confidence'
    )
  );

  const allPass = conditions.every((c) => c.status === 'PASS') && block == null;
  let direction: SetupRecord['direction'] = null;
  if (allPass && dir != null) {
    direction = dir >= 0 ? 'LONG' : 'SHORT';
  } else if (!block) {
    block = 'NO_SETUP';
  }

  return {
    setup_id: randomUUID(),
    strategy_id: input.strategy_id || 'trend_continuation',
    instrument: input.market.instrument,
    timestamp: input.market.as_of,
    direction,
    conditions,
    all_pass: allPass,
    market_state: input.market,
    feed_quality: input.feed.quality,
    entry_reference: input.entryReference ?? input.feed.trading_price,
    invalidation_reference: input.invalidationReference ?? null,
    evidence: conditions.map((c) => `${c.name}=${c.status} actual=${String(c.actual)}`),
    block: allPass ? null : block,
  };
}
