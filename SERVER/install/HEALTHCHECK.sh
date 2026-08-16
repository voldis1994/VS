#!/usr/bin/env bash
# HEALTHCHECK — process vs trading readiness (never invents TRADING_READY).
set -euo pipefail
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
PORT="${CONTROL_API_PORT:-3000}"
if [[ -f "$DATA/server.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DATA/server.env"
  set +a
fi
PORT="${CONTROL_API_PORT:-$PORT}"
echo "VS HEALTHCHECK"
echo "LIVE_TRADING_ENABLED=${LIVE_TRADING_ENABLED:-false}"
if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null; then
  echo "CONTROL_API=READY"
else
  echo "CONTROL_API=FAILED"
  exit 1
fi
TOKEN="${API_ADMIN_TOKEN:-}"
if [[ -n "$TOKEN" && "$TOKEN" != "CHANGE_ME_ADMIN_TOKEN" ]]; then
  curl -fsS -H "x-admin-token: $TOKEN" "http://127.0.0.1:${PORT}/api/v1/system/supervisor" | head -c 2000 || true
  echo
fi
exec bash "$(cd "$(dirname "$0")/.." && pwd)/STATUS_SERVER"
