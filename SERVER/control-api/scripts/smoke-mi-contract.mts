import * as mi from '../../core/market-intelligence/src/index.js';
import { buildMarketStateVector } from '../../core/market-intelligence/src/index.js';

const required = [
  'buildMarketStateVector',
  'validateMultiFeed',
  'rawTickFromParts',
  'evaluateTrendContinuationSetup',
  'computeProtectiveStop',
  'computeLotSize',
  'buildTradeExplanation',
] as const;

const missing = required.filter((k) => typeof (mi as Record<string, unknown>)[k] !== 'function');
if (missing.length) {
  console.error('MISSING', missing);
  console.error('HAVE', Object.keys(mi).sort());
  process.exit(1);
}
if (typeof buildMarketStateVector !== 'function') {
  console.error('named import failed');
  process.exit(1);
}
console.log('OK market-intelligence contract', required.join(','));
