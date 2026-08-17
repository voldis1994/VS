/**
 * Multi-dimensional market state — measurements, not fake FLAT/UNKNOWN regimes.
 * Label is UI-only interpretation derived from scores.
 */
import type { Candle10s, MarketStateVector } from './types.js';
/**
 * Build market state from closed 10s candles available at asOf.
 * Returns INSUFFICIENT_DATA rather than inventing FLAT/UNKNOWN market regimes.
 */
export declare function buildMarketStateVector(input: {
    instrument: string;
    candles: Candle10s[];
    asOf: string;
    feedConfidence?: number | null;
    spreadQuality?: number | null;
    minBars?: number;
}): MarketStateVector;
