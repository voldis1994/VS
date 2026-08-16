/**
 * Canonical public API for market-intelligence.
 * Explicit named re-exports only — `export *` is unreliable under tsx/Node ESM
 * and caused physical boot: missing buildMarketStateVector.
 */

export type {
  OperationalBlock,
  RawTickEvent,
  FeedValidationReport,
  Candle10s,
  MarketStateVector,
  ConditionResult,
  SetupRecord,
  ProtectiveStopPlan,
  LotPlan,
  OrderLifecycleState,
  TradeExplanation,
} from './types.js';

export type { ValidateFeedsInput } from './feedValidation.js';
export { validateMultiFeed, rawTickFromParts } from './feedValidation.js';

export {
  TEN_SEC_MS,
  candle10sBucketStartMs,
  candle10sBucketIso,
  emptyOhlc10sState,
  ingestTickTo10s,
  aggregateFrom10s,
  candlesAvailableAt,
} from './ohlc10s.js';
export type { Ohlc10sBuilderState } from './ohlc10s.js';

export { buildMarketStateVector } from './marketState.js';

export {
  evalCondition,
  DEFAULT_TREND_CONTINUATION,
  evaluateTrendContinuationSetup,
} from './setupEngine.js';
export type { TrendContinuationParams } from './setupEngine.js';

export { computeProtectiveStop } from './protectiveStop.js';
export type { ProtectiveStopInput } from './protectiveStop.js';

export { computeLotSize } from './lotSizing.js';
export type { InstrumentLotSpec, LotPolicy } from './lotSizing.js';

export { canTransitionOrder, transitionOrder } from './orderLifecycle.js';

export { updateExcursion, rankExitCandidates } from './exitEngine.js';
export type { PositionExcursion, ExitCandidate } from './exitEngine.js';

export { buildTradeExplanation } from './explainability.js';
