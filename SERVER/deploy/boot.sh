#!/usr/bin/env bash
# VS SERVER Linux boot — appliance entry (systemd / START_SERVER).
# POWER ON → this script → SERVER services. Never claims LIVE READY without evidence.
set -euo pipefail

ROOT="${VS_SERVER_ROOT:-${VS_CORE_ROOT:-/opt/vs-server}}"
DATA="${VS_SERVER_DATA:-${VS_CORE_DATA:-/var/lib/vs-server}}"
LOG="${VS_SERVER_LOG:-${VS_CORE_LOG:-/var/log/vs-server}}"

if [[ -f "$DATA/server.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DATA/server.env"
  set +a
fi
if [[ -f "$ROOT/control-api/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT/control-api/.env"
  set +a
fi

export NODE_ENV="${NODE_ENV:-production}"
export OPERATING_MODE="${OPERATING_MODE:-DEMO}"
export LIVE_TRADING_ENABLED="${LIVE_TRADING_ENABLED:-false}"
export CONTROL_API_HOST="${CONTROL_API_HOST:-10.77.0.1}"
export CONTROL_API_PORT="${CONTROL_API_PORT:-3000}"
export VS_CORE_DATA="$DATA"
export VS_CORE_ROOT="$ROOT"
export VS_SERVER_DATA="$DATA"
export VS_SERVER_ROOT="$ROOT"

mkdir -p "$DATA" "$LOG" "$DATA/market" "$DATA/backup" "$DATA/updates" "$DATA/orders"

echo "VS SERVER"
echo "BOOTING"
echo "SERVER_ROOT=$ROOT"
echo "DATA=$DATA"

if command -v timedatectl >/dev/null 2>&1; then
  timedatectl show -p NTPSynchronized --value 2>/dev/null || true
fi

# Authoritative control-api only — no legacy fallbacks
API_DIR="$ROOT/control-api"
if [[ ! -d "$API_DIR" ]]; then
  echo "FAIL: control-api not found under $ROOT" >&2
  exit 1
fi

cd "$API_DIR"
if [[ ! -d node_modules ]]; then
  echo "FAIL: node_modules missing — run INSTALL_SERVER" >&2
  exit 1
fi

if [[ -x "$API_DIR/node_modules/.bin/tsx" ]]; then
  exec "$API_DIR/node_modules/.bin/tsx" src/vs-core/runAppliance.ts
fi

# Fallback if tsx binary path odd but package present
if [[ -d "$API_DIR/node_modules/tsx" ]]; then
  exec node --import tsx src/vs-core/runAppliance.ts
fi

echo "FAIL: tsx missing — run: cd $API_DIR && npm install tsx" >&2
exit 1
