/**
 * Canonical public API for market-data.
 * Explicit named re-exports — avoid `export *` under tsx/Node ESM.
 */

export type {
  SymbolId,
  MarketTick,
  Quote,
  Candle,
  Timeframe,
  MarketQualityState,
  MarketSnapshot,
  TickValidation,
} from './types.js';
export { validateTick, isStale, TIMEFRAMES, timeframeMinutes } from './types.js';

export type { FeedLifecycleState, SymbolBook, FeedConfig } from './feed.js';
export { MarketFeedBook, aggregateCandles } from './feed.js';
