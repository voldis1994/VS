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

# CRITICAL: server.env wins for DB_* (control-api/.env often has stale password → 28P01)
if [[ -f "$DATA/server.env" ]]; then
  # shellcheck disable=SC1090
  set -a
  source <(grep -E '^DB_(HOST|PORT|NAME|USER|PASSWORD)=' "$DATA/server.env" | sed 's/\r$//')
  set +a
fi

export NODE_ENV="${NODE_ENV:-production}"
export OPERATING_MODE="${OPERATING_MODE:-DEMO}"
export LIVE_TRADING_ENABLED="${LIVE_TRADING_ENABLED:-false}"
export CONTROL_API_PORT="${CONTROL_API_PORT:-3000}"
export VS_CORE_DATA="$DATA"
export VS_CORE_ROOT="$ROOT"
export VS_SERVER_DATA="$DATA"
export VS_SERVER_ROOT="$ROOT"
export VS_LAN_MANAGEMENT="${VS_LAN_MANAGEMENT:-1}"
export VS_PRIVATE_NETWORK="${VS_PRIVATE_NETWORK:-1}"

# CRITICAL: after sourcing stale .env, force LAN-reachable bind.
# Never default to WireGuard-only 10.77.0.1 (breaks 127.0.0.1 + MSI LAN).
if [[ "${VS_LAN_MANAGEMENT}" == "1" || "${VS_LAN_MANAGEMENT}" == "true" ]]; then
  export CONTROL_API_HOST=0.0.0.0
else
  export CONTROL_API_HOST="${CONTROL_API_HOST:-127.0.0.1}"
  if [[ "${CONTROL_API_HOST}" == "10.77.0.1" ]]; then
    echo "WARN: CONTROL_API_HOST=10.77.0.1 without LAN management — forcing 127.0.0.1" >&2
    export CONTROL_API_HOST=127.0.0.1
  fi
fi

mkdir -p "$DATA" "$LOG" "$DATA/market" "$DATA/backup" "$DATA/updates" "$DATA/orders"

echo "VS SERVER"
echo "BOOTING"
echo "SERVER_ROOT=$ROOT"
echo "DATA=$DATA"
echo "CONTROL_API_HOST=$CONTROL_API_HOST"
echo "CONTROL_API_PORT=$CONTROL_API_PORT"
echo "VS_LAN_MANAGEMENT=$VS_LAN_MANAGEMENT"

if command -v timedatectl >/dev/null 2>&1; then
  timedatectl show -p NTPSynchronized --value 2>/dev/null || true
fi

# Bring up WireGuard if configured (non-fatal for LAN-only ADMIN)
if [[ -x "$ROOT/network/UP_WIREGUARD" ]]; then
  VS_SERVER_DATA="$DATA" "$ROOT/network/UP_WIREGUARD" >/dev/null 2>&1 || \
    echo "WARN: UP_WIREGUARD failed — LAN ADMIN still works if CONTROL_API_HOST=0.0.0.0"
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
