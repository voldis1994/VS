/**
 * Setup engine — measurable PASS/FAIL conditions only.
 * Never: if (regime == X) BUY
 */
import type { ConditionResult, FeedValidationReport, MarketStateVector, SetupRecord } from './types.js';
export declare function evalCondition(name: string, pass: boolean, actual: ConditionResult['actual'], threshold: ConditionResult['threshold'], detail: string): ConditionResult;
export type TrendContinuationParams = {
    minTrendStrength: number;
    minTrendQuality: number;
    minAbsDirection: number;
    maxNoise: number;
    minFeedConfidence: number;
};
export declare const DEFAULT_TREND_CONTINUATION: TrendContinuationParams;
/**
 * Trend continuation setup — all conditions must PASS.
 * Returns NO_SETUP / DATA_QUALITY_BLOCK / INSUFFICIENT_DATA when blocked.
 */
export declare function evaluateTrendContinuationSetup(input: {
    strategy_id?: string;
    market: MarketStateVector;
    feed: Pick<FeedValidationReport, 'quality' | 'trading_price' | 'block' | 'detail'>;
    params?: Partial<TrendContinuationParams>;
    entryReference?: number | null;
    invalidationReference?: number | null;
}): SetupRecord;
