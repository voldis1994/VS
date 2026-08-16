/** Feature extraction for trend continuation — closed candles only. */

import { buildMarketStateVector } from '../../market-intelligence/src/marketState.ts';
import type { Candle10s } from '../../market-intelligence/src/types.ts';

export function extractTrendContinuationFeatures(input: {
  instrument: string;
  candles: Candle10s[];
  asOf: string;
  feedConfidence?: number | null;
  spreadQuality?: number | null;
}) {
  return buildMarketStateVector(input);
}
