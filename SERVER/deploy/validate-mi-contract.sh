#!/usr/bin/env bash
# Validate production module contracts before Control API boot.
# Fails closed if buildMarketStateVector (or other required symbols) missing.
set -euo pipefail

PREFIX="${VS_SERVER_PREFIX:-${VS_SERVER_ROOT:-/opt/vs-server}}"
API="${PREFIX}/control-api"
MI_INDEX="${PREFIX}/core/market-intelligence/src/index.ts"
SMOKE="${API}/scripts/smoke-production-modules.mts"

if [[ ! -f "$MI_INDEX" ]]; then
  echo "FAIL: missing $MI_INDEX — sync SERVER/core into $PREFIX" >&2
  exit 1
fi

if ! grep -q 'buildMarketStateVector' "$MI_INDEX"; then
  echo "FAIL: $MI_INDEX does not mention buildMarketStateVector (stale export *?)" >&2
  exit 1
fi

if ! grep -q "export { buildMarketStateVector }" "$MI_INDEX"; then
  echo "FAIL: index must explicitly export { buildMarketStateVector } (export * broken under tsx)" >&2
  exit 1
fi

if [[ ! -f "$SMOKE" ]]; then
  # Fallback to older MI-only smoke if new script not deployed yet
  SMOKE="${API}/scripts/smoke-mi-contract.mts"
fi

if [[ ! -f "$SMOKE" ]]; then
  echo "FAIL: missing smoke script under $API/scripts" >&2
  exit 1
fi

if [[ ! -x "$API/node_modules/.bin/tsx" && ! -d "$API/node_modules/tsx" ]]; then
  echo "FAIL: tsx missing under $API" >&2
  exit 1
fi

cd "$API"
./node_modules/.bin/tsx "$SMOKE"
