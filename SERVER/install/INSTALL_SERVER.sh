#!/usr/bin/env bash
# Canonical installer — COMPLETE physical i3 server (idempotent).
#   sudo bash SERVER/install/INSTALL_SERVER.sh
#
# Running twice repairs/updates the same /opt/vs-server tree — never a second install.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$SERVER/.." && pwd)"
PREFIX="${VS_SERVER_PREFIX:-/opt/vs-server}"
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: run as root: sudo bash $0" >&2
  exit 1
fi
export LIVE_TRADING_ENABLED=false
export VS_SERVER_PREFIX="$PREFIX"
export VS_SERVER_DATA="$DATA"

step() { echo ""; echo "======== [$1] $2 ========"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

step 1 "verify Debian dependencies"
command -v curl >/dev/null || apt-get install -y -qq curl
command -v rsync >/dev/null || apt-get install -y -qq rsync
command -v openssl >/dev/null || apt-get install -y -qq openssl
command -v ss >/dev/null || apt-get install -y -qq iproute2

step 2 "verify/install Node runtime"
if ! command -v node >/dev/null; then
  fail "node not installed — install Node 20+ then re-run"
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  fail "Node ${NODE_MAJOR} too old — need 18+"
fi
echo "OK node $(node -v)"

step 3 "Docker check (Postgres/Redis)"
if command -v docker >/dev/null; then
  echo "OK docker $(docker --version 2>/dev/null | head -1)"
else
  echo "WARN: docker missing — MAKE_IT_WORK will attempt to enable/use it"
fi

step 4 "classic tree install (packages, units, compose)"
# May partially succeed on already-installed hosts; MAKE_IT_WORK is the authority.
bash "$SERVER/INSTALL_I3_SERVER" "$@" || echo "WARN: INSTALL_I3_SERVER non-zero — continuing with MAKE_IT_WORK"

step 5 "authoritative deploy: deps, build, DB, Redis, systemd, start"
# Single nuclear path: sync current commit → /opt, one DB password, MI gate, start API
bash "$SERVER/MAKE_IT_WORK.sh"

step 6 "validate market-intelligence + core module exports"
bash "$SERVER/deploy/validate-mi-contract.sh" || fail "module contract validation failed after deploy"

step 7 "wait for Postgres"
for i in $(seq 1 30); do
  if docker exec market-reader-postgres pg_isready -U market_reader >/dev/null 2>&1; then
    echo "OK postgres ready"
    break
  fi
  [[ "$i" -eq 30 ]] && echo "WARN: postgres pg_isready timed out"
  sleep 1
done

step 8 "wait for Control API + identity"
ok=0
for i in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[[ "$ok" -eq 1 ]] || fail "Control API /health not up after install"

HEALTH="$(curl -fsS http://127.0.0.1:3000/health)"
echo "$HEALTH" | head -c 800
echo
echo "$HEALTH" | grep -q '"service":"VS-CORE"' || fail "/health missing service=VS-CORE"
echo "$HEALTH" | grep -q '"server_id"' || fail "/health missing server_id"
echo "$HEALTH" | grep -q '"build_commit"' || fail "/health missing build_commit"

step 9 "port + systemd physical checks"
ss -ltnp | grep -q ':3000' || fail "nothing listening on :3000"
systemctl is-active vs-server >/dev/null || fail "vs-server not active"

for wait_s in 5 30; do
  sleep "$wait_s"
  systemctl is-active vs-server >/dev/null || fail "vs-server not active after ${wait_s}s"
done
echo "OK vs-server still active after 5s and 30s"

if journalctl -u vs-server -n 80 --no-pager 2>/dev/null | grep -Eiq 'SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export named'; then
  journalctl -u vs-server -n 40 --no-pager >&2 || true
  fail "vs-server journal shows module/export errors"
fi

step 10 "done"
echo "SUCCESS: INSTALL_SERVER complete"
echo "PREFIX=$PREFIX"
echo "BUILD=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "Idempotent: re-run repairs the same installation."
exit 0
