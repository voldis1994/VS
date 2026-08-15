#!/usr/bin/env bash
# VS CORE Linux boot — appliance entry (not a desktop session).
# POWER ON → this script (via systemd) → VS CORE READY / NOT READY
set -euo pipefail

ROOT="${VS_CORE_ROOT:-/opt/vs-core}"
DATA="${VS_CORE_DATA:-/var/lib/vs-core}"
LOG="${VS_CORE_LOG:-/var/log/vs-core}"
export NODE_ENV="${NODE_ENV:-production}"
export OPERATING_MODE="${OPERATING_MODE:-DEMO}"
# Never auto-enable LIVE money on appliance boot
export LIVE_TRADING_ENABLED="${LIVE_TRADING_ENABLED:-false}"
export CONTROL_API_HOST="${CONTROL_API_HOST:-127.0.0.1}"
export CONTROL_API_PORT="${CONTROL_API_PORT:-3000}"

mkdir -p "$DATA" "$LOG" "$DATA/market" "$DATA/backup" "$DATA/updates"

echo "VS CORE"
echo "BOOTING"
echo "CORE_ROOT=$ROOT"
echo "DATA=$DATA"

# Time sync hint (chrony/systemd-timesyncd must be configured on host)
if command -v timedatectl >/dev/null 2>&1; then
  timedatectl show -p NTPSynchronized --value 2>/dev/null || true
fi

cd "$ROOT/apps/control-api"
if [[ ! -d node_modules ]]; then
  echo "Installing control-api dependencies..."
  npm ci --omit=dev
fi

# Migrations + Control API (includes Mobile /api/v1 + robotDesk brain)
exec node --import tsx src/vs-core/runAppliance.ts
