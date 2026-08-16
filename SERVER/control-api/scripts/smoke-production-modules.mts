/**
 * Production runtime import smoke — same modules physical Debian boots via tsx.
 * Exit 1 on any missing named export / SyntaxError / ERR_MODULE_NOT_FOUND.
 */
import {
  buildMarketStateVector,
  validateMultiFeed,
  rawTickFromParts,
  evaluateTrendContinuationSetup,
  computeProtectiveStop,
  computeLotSize,
  buildTradeExplanation,
} from '../../core/market-intelligence/src/index.js';
import * as marketData from '../../core/market-data/src/index.js';
import * as strategy from '../../core/strategy/src/index.js';
import * as risk from '../../core/risk/src/index.js';
import * as execution from '../../core/execution/src/index.js';
import * as reconciliation from '../../core/reconciliation/src/index.js';
import * as supervisor from '../../core/supervisor/src/index.js';

const miRequired = {
  buildMarketStateVector,
  validateMultiFeed,
  rawTickFromParts,
  evaluateTrendContinuationSetup,
  computeProtectiveStop,
  computeLotSize,
  buildTradeExplanation,
} as const;

for (const [k, v] of Object.entries(miRequired)) {
  if (typeof v !== 'function') {
    console.error('FAIL: missing MI export', k);
    process.exit(1);
  }
}

if (typeof marketData.validateTick !== 'function') {
  console.error('FAIL: market-data.validateTick');
  process.exit(1);
}
if (!Array.isArray(strategy.STRATEGY_REGISTRY)) {
  console.error('FAIL: strategy.STRATEGY_REGISTRY');
  process.exit(1);
}
if (typeof risk.atrStop !== 'function') {
  console.error('FAIL: risk.atrStop');
  process.exit(1);
}
if (typeof execution.canTransition !== 'function') {
  console.error('FAIL: execution.canTransition');
  process.exit(1);
}
if (typeof reconciliation.compareSets !== 'function') {
  console.error('FAIL: reconciliation.compareSets');
  process.exit(1);
}
if (typeof supervisor.evaluateSupervisor !== 'function') {
  console.error('FAIL: supervisor.evaluateSupervisor');
  process.exit(1);
}

// Prove named destructure works (the physical failure mode)
const { buildMarketStateVector: bmsv } = await import(
  '../../core/market-intelligence/src/index.js'
);
if (typeof bmsv !== 'function') {
  console.error('FAIL: named ESM import buildMarketStateVector');
  process.exit(1);
}

console.log(
  'OK: production module contracts verified (MI + market-data + strategy + risk + execution + reconciliation + supervisor)'
);
