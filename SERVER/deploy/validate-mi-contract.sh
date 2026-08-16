#!/usr/bin/env bash
# Validate market-intelligence public API before Control API boot.
# Fails closed if buildMarketStateVector (or other required symbols) missing.
set -euo pipefail

PREFIX="${VS_SERVER_PREFIX:-${VS_SERVER_ROOT:-/opt/vs-server}}"
API="${PREFIX}/control-api"
MI_INDEX="${PREFIX}/core/market-intelligence/src/index.ts"

if [[ ! -f "$MI_INDEX" ]]; then
  echo "FAIL: missing $MI_INDEX — sync SERVER/core into $PREFIX" >&2
  exit 1
fi

if ! grep -q 'buildMarketStateVector' "$MI_INDEX"; then
  echo "FAIL: $MI_INDEX does not mention buildMarketStateVector (stale export *?)" >&2
  exit 1
fi

if [[ ! -x "$API/node_modules/.bin/tsx" && ! -d "$API/node_modules/tsx" ]]; then
  echo "FAIL: tsx missing under $API" >&2
  exit 1
fi

cd "$API"
./node_modules/.bin/tsx -e "
import {
  buildMarketStateVector,
  validateMultiFeed,
  rawTickFromParts,
  evaluateTrendContinuationSetup,
  computeProtectiveStop,
  computeLotSize,
  buildTradeExplanation,
} from '../core/market-intelligence/src/index.js';
const fns = {
  buildMarketStateVector,
  validateMultiFeed,
  rawTickFromParts,
  evaluateTrendContinuationSetup,
  computeProtectiveStop,
  computeLotSize,
  buildTradeExplanation,
};
for (const [k, v] of Object.entries(fns)) {
  if (typeof v !== 'function') {
    console.error('FAIL: missing export', k);
    process.exit(1);
  }
}
console.log('OK: market-intelligence contract exports verified');
"
