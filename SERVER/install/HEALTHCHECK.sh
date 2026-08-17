#!/usr/bin/env bash
# HEALTHCHECK — authoritative. Separates PROCESS / SYSTEM / TRADING readiness.
# Never invents READY or TRADING_READY.
set -euo pipefail
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
PORT="${CONTROL_API_PORT:-3000}"
CLIENT_PORT="${CLIENT_API_PORT:-3001}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$DATA/server.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DATA/server.env"
  set +a
fi
PORT="${CONTROL_API_PORT:-$PORT}"

PROCESS=0
SYSTEM=0
TRADING=0

echo "VS HEALTHCHECK"
echo "=============="
echo "LIVE_TRADING_ENABLED=${LIVE_TRADING_ENABLED:-false}"

if systemctl is-active --quiet vs-server.service 2>/dev/null; then
  echo "[PASS] systemd vs-server"
  PROCESS=1
else
  echo "[FAIL] systemd vs-server"
fi

if docker exec market-reader-postgres pg_isready -U "${DB_USER:-market_reader}" >/dev/null 2>&1 \
  || (command -v pg_isready >/dev/null && pg_isready -h 127.0.0.1 >/dev/null 2>&1); then
  echo "[PASS] database"
else
  echo "[FAIL] database"
  PROCESS=0
fi

if docker exec market-reader-redis redis-cli ping 2>/dev/null | grep -q PONG \
  || (command -v redis-cli >/dev/null && redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG); then
  echo "[PASS] redis"
else
  echo "[CONFIG_REQUIRED] redis (optional / unreachable)"
fi

if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "[PASS] control-api"
else
  echo "[FAIL] control-api"
  PROCESS=0
fi

# Client gateway :443 (public door)
if curl -fsS "http://127.0.0.1:443/health" >/dev/null 2>&1 \
  || curl -fkSs "https://127.0.0.1/health" >/dev/null 2>&1; then
  echo "[PASS] client-gateway"
else
  echo "[WARN] client-gateway not answering on :443 yet"
fi

WG_IFACE="${VS_WG_INTERFACE:-vs0}"
if ip -4 addr show dev "$WG_IFACE" 2>/dev/null | grep -q 'inet '; then
  echo "[PASS] wireguard $WG_IFACE"
else
  echo "[CONFIG_REQUIRED] wireguard ($WG_IFACE down — LAN ADMIN may still work)"
fi

TOKEN="${API_ADMIN_TOKEN:-}"
if [[ -n "$TOKEN" && "$TOKEN" != "CHANGE_ME_ADMIN_TOKEN" ]]; then
  BODY="$(curl -fsS -H "x-admin-token: $TOKEN" "http://127.0.0.1:${PORT}/api/v1/system/supervisor" 2>/dev/null || true)"
  if echo "$BODY" | grep -q '"trading_ready"[[:space:]]*:[[:space:]]*true'; then
    TRADING=1
    echo "[PASS] trading_ready=true"
  else
    echo "[INFO] trading_ready=false (fail-closed)"
  fi
  if echo "$BODY" | grep -q 'CONFIG_REQUIRED'; then
    echo "[CONFIG_REQUIRED] broker or dependency"
  fi
else
  echo "[CONFIG_REQUIRED] admin token missing — cannot probe supervisor"
fi

echo "=============="
echo "PROCESS READY: $([[ $PROCESS -eq 1 ]] && echo YES || echo NO)"
echo "SYSTEM READY:  $([[ $SYSTEM -eq 1 ]] && echo YES || echo NO)"
echo "TRADING READY: $([[ $TRADING -eq 1 ]] && echo YES || echo NO)"
if [[ $PROCESS -ne 1 ]]; then
  exit 1
fi
exit 0
