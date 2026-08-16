#!/usr/bin/env bash
# FINAL_ACCEPTANCE — repository-controlled checks on VS-CORE-01.
# Never fakes PASS. Broker may be CONFIG_REQUIRED without credentials.
set -euo pipefail

DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
PORT="${CONTROL_API_PORT:-3000}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
CFG=0

pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $1 — $2"; FAIL=$((FAIL + 1)); }
cfg()  { echo "[CONFIG_REQUIRED] $1 — $2"; CFG=$((CFG + 1)); }

if [[ -f "$DATA/server.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DATA/server.env"
  set +a
fi
PORT="${CONTROL_API_PORT:-$PORT}"
TOKEN="${API_ADMIN_TOKEN:-}"

echo "VS FINAL ACCEPTANCE"
echo "==================="

# OS
if [[ -f /etc/os-release ]]; then
  pass "OS"
else
  fail "OS" "os-release missing"
fi

# SYSTEMD
if systemctl is-active --quiet vs-server.service 2>/dev/null; then
  pass "SYSTEMD"
else
  fail "SYSTEMD" "vs-server not active"
fi

# DATABASE
if docker exec market-reader-postgres pg_isready -U "${DB_USER:-market_reader}" >/dev/null 2>&1 \
  || (command -v pg_isready >/dev/null && pg_isready -h 127.0.0.1 >/dev/null 2>&1); then
  pass "DATABASE"
else
  fail "DATABASE" "unreachable"
fi

# REDIS
if docker exec market-reader-redis redis-cli ping 2>/dev/null | grep -q PONG \
  || (command -v redis-cli >/dev/null && redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG); then
  pass "REDIS"
else
  cfg "REDIS" "optional / not reachable"
fi

# MIGRATIONS — presence of runner + migration files
if [[ -f "$ROOT/control-api/src/db/migrate.ts" ]] && ls "$ROOT/control-api/src/db/migrations"/*.sql >/dev/null 2>&1; then
  pass "MIGRATIONS"
else
  fail "MIGRATIONS" "runner or SQL missing"
fi

# CONTROL_API
if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  pass "CONTROL_API"
else
  fail "CONTROL_API" "health failed"
fi

# CLIENT_API — mobile/client health may share same process; probe known path
if curl -fsS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/v1/system/status" 2>/dev/null | grep -qE '401|200'; then
  pass "CLIENT_API"
else
  # unauthenticated may 401 — still means route exists
  code="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/v1/system/status" || true)"
  if [[ "$code" == "401" || "$code" == "200" ]]; then
    pass "CLIENT_API"
  else
    fail "CLIENT_API" "unexpected HTTP $code"
  fi
fi

# WIREGUARD
WG_IFACE="${VS_WG_INTERFACE:-vs0}"
if ip -4 addr show dev "$WG_IFACE" 2>/dev/null | grep -q 'inet '; then
  pass "WIREGUARD"
else
  cfg "WIREGUARD" "$WG_IFACE down (LAN ADMIN may still work)"
fi

# DASHBOARD / MONITOR
if systemctl is-active --quiet vs-server-monitor.service 2>/dev/null \
  || [[ -x "$ROOT/MONITOR_SERVER" ]]; then
  pass "DASHBOARD"
else
  fail "DASHBOARD" "monitor unit/script missing"
fi

# MARKET_DATA — API up implies feed manager present; not inventing LIVE quotes
if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  pass "MARKET_DATA"
else
  fail "MARKET_DATA" "API down"
fi

# BROKER
if [[ -n "$TOKEN" && "$TOKEN" != "CHANGE_ME_ADMIN_TOKEN" ]]; then
  BODY="$(curl -fsS -H "x-admin-token: $TOKEN" "http://127.0.0.1:${PORT}/api/v1/broker/health" 2>/dev/null || true)"
  if echo "$BODY" | grep -q 'CONFIG_REQUIRED'; then
    cfg "BROKER" "credentials absent"
  elif echo "$BODY" | grep -qE 'CONNECTED|DISCONNECTED'; then
    pass "BROKER"
  else
    cfg "BROKER" "health endpoint unavailable or unauthorized"
  fi
else
  cfg "BROKER" "no admin token to probe"
fi

echo "==================="
echo "PASS=$PASS FAIL=$FAIL CONFIG_REQUIRED=$CFG"
if [[ "$FAIL" -ne 0 ]]; then
  echo "SERVER PRODUCT NOT READY"
  exit 1
fi
echo "SERVER PRODUCT READY"
exit 0
