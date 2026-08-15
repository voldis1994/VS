#!/usr/bin/env bash
# VS SERVER Linux boot — appliance entry (systemd / START_SERVER).
# POWER ON → this script → SERVER services. Never claims LIVE READY without evidence.
set -euo pipefail

ROOT="${VS_SERVER_ROOT:-${VS_CORE_ROOT:-/opt/vs-server}}"
DATA="${VS_SERVER_DATA:-${VS_CORE_DATA:-/var/lib/vs-server}}"
LOG="${VS_SERVER_LOG:-${VS_CORE_LOG:-/var/log/vs-server}}"
export NODE_ENV="${NODE_ENV:-production}"
export OPERATING_MODE="${OPERATING_MODE:-DEMO}"
export LIVE_TRADING_ENABLED="${LIVE_TRADING_ENABLED:-false}"
export CONTROL_API_HOST="${CONTROL_API_HOST:-127.0.0.1}"
export CONTROL_API_PORT="${CONTROL_API_PORT:-3000}"
export VS_CORE_DATA="$DATA"
export VS_CORE_ROOT="$ROOT"

mkdir -p "$DATA" "$LOG" "$DATA/market" "$DATA/backup" "$DATA/updates" "$DATA/orders"

echo "VS SERVER"
echo "BOOTING"
echo "SERVER_ROOT=$ROOT"
echo "DATA=$DATA"

if command -v timedatectl >/dev/null 2>&1; then
  timedatectl show -p NTPSynchronized --value 2>/dev/null || true
fi

# Prefer new layout; fall back to legacy path during transition
API_DIR="$ROOT/control-api"
if [[ ! -d "$API_DIR" && -d "$ROOT/apps/control-api" ]]; then
  API_DIR="$ROOT/apps/control-api"
fi
if [[ ! -d "$API_DIR" ]]; then
  echo "FAIL: control-api not found under $ROOT" >&2
  exit 1
fi

cd "$API_DIR"
if [[ ! -d node_modules ]]; then
  echo "FAIL: node_modules missing — run INSTALL_SERVER" >&2
  exit 1
fi

exec node --import tsx src/vs-core/runAppliance.ts
