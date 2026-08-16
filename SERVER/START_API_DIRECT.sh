#!/usr/bin/env bash
# Start Control API directly (no systemd). Emergency / diagnostic path.
#   sudo bash SERVER/START_API_DIRECT.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: run as root: sudo bash $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${VS_SERVER_PREFIX:-/opt/vs-server}"
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
LOG="${VS_SERVER_LOG:-/var/log/vs-server}"
API="$PREFIX/control-api"
RUN_USER="${VS_SERVER_USER:-vs-server}"
PID_FILE="$DATA/vs-api-direct.pid"
OUT_LOG="$LOG/api-direct.out"

mkdir -p "$DATA" "$LOG"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin "$RUN_USER"

force_kv() {
  local f="$1" k="$2" v="$3"
  [[ -f "$f" ]] || touch "$f"
  if grep -qE "^${k}=" "$f" 2>/dev/null; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >>"$f"
  fi
}

echo "======== START_API_DIRECT ========"

# Postgres first
if [[ -x "$HERE/deploy/ensure-postgres.sh" ]]; then
  bash "$HERE/deploy/ensure-postgres.sh" || docker start market-reader-postgres market-reader-redis || true
elif [[ -x "$PREFIX/deploy/ensure-postgres.sh" ]]; then
  bash "$PREFIX/deploy/ensure-postgres.sh" || docker start market-reader-postgres market-reader-redis || true
else
  docker start market-reader-postgres market-reader-redis || true
fi

echo "==> sync DB password"
if [[ -x "$HERE/deploy/fix-db-password.sh" ]]; then
  bash "$HERE/deploy/fix-db-password.sh"
elif [[ -x "$PREFIX/deploy/fix-db-password.sh" ]]; then
  bash "$PREFIX/deploy/fix-db-password.sh"
fi

# Sync minimal runtime from git tree if present
if [[ -d "$HERE/control-api/src" ]]; then
  mkdir -p "$API" "$PREFIX/core"
  rsync -a --exclude node_modules --exclude dist --exclude data "$HERE/control-api/" "$API/"
  rsync -a --exclude node_modules --exclude dist "$HERE/core/" "$PREFIX/core/"
  mkdir -p "$PREFIX/deploy"
  rsync -a "$HERE/deploy/" "$PREFIX/deploy/"
  chmod +x "$PREFIX/deploy/"*.sh 2>/dev/null || true
fi

for f in "$DATA/server.env" "$API/.env"; do
  [[ -f "$f" ]] || continue
  force_kv "$f" VS_LAN_MANAGEMENT 1
  force_kv "$f" CONTROL_API_HOST 0.0.0.0
  force_kv "$f" CONTROL_API_PORT 3000
  force_kv "$f" LIVE_TRADING_ENABLED false
done

# shellcheck disable=SC1090
[[ -f "$DATA/server.env" ]] && { set -a; source "$DATA/server.env"; set +a; }
if [[ -z "${MASTER_ENCRYPTION_KEY:-}" || "$MASTER_ENCRYPTION_KEY" == *CHANGE_ME* || ${#MASTER_ENCRYPTION_KEY} -lt 32 ]]; then
  K="$(openssl rand -hex 32)"
  force_kv "$DATA/server.env" MASTER_ENCRYPTION_KEY "$K"
  force_kv "$API/.env" MASTER_ENCRYPTION_KEY "$K"
  echo "WARN: generated MASTER_ENCRYPTION_KEY"
fi
if [[ -z "${API_ADMIN_TOKEN:-}" || "$API_ADMIN_TOKEN" == CHANGE_ME* ]]; then
  T="$(openssl rand -hex 24)"
  force_kv "$DATA/server.env" API_ADMIN_TOKEN "$T"
  force_kv "$API/.env" API_ADMIN_TOKEN "$T"
  echo "WARN: generated API_ADMIN_TOKEN"
fi

if [[ ! -x "$API/node_modules/.bin/tsx" && ! -d "$API/node_modules/tsx" ]]; then
  echo "==> npm install in $API"
  chown -R "$RUN_USER:$RUN_USER" "$API" "$DATA" "$LOG"
  sudo -u "$RUN_USER" bash -lc "cd '$API' && (npm ci || npm install) && npm install tsx@^4.19.0 --save"
fi

# Kill stale listeners on 3000
if command -v fuser >/dev/null 2>&1; then
  fuser -k 3000/tcp 2>/dev/null || true
fi
if [[ -f "$PID_FILE" ]]; then
  old="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    kill "$old" 2>/dev/null || true
    sleep 1
    kill -9 "$old" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

chown -R "$RUN_USER:$RUN_USER" "$API" "$DATA" "$LOG" "$PREFIX" 2>/dev/null || true

BOOT="$PREFIX/deploy/boot.sh"
if [[ ! -x "$BOOT" ]]; then
  BOOT="$HERE/deploy/boot.sh"
fi
chmod +x "$BOOT"

echo "==> launching boot.sh as $RUN_USER (direct, no systemd)"
# Run as root if vs-server cannot bind / read — still force LAN bind via env
export VS_SERVER_ROOT="$PREFIX"
export VS_CORE_ROOT="$PREFIX"
export VS_SERVER_DATA="$DATA"
export VS_CORE_DATA="$DATA"
export VS_LAN_MANAGEMENT=1
export VS_PRIVATE_NETWORK=1
export CONTROL_API_HOST=0.0.0.0
export CONTROL_API_PORT=3000
export NODE_ENV=production
export LIVE_TRADING_ENABLED=false
export OPERATING_MODE="${OPERATING_MODE:-PRODUCTION}"

# Prefer service user; fall back to root if that fails health
set +e
sudo -u "$RUN_USER" env \
  VS_SERVER_ROOT="$PREFIX" VS_CORE_ROOT="$PREFIX" \
  VS_SERVER_DATA="$DATA" VS_CORE_DATA="$DATA" \
  VS_LAN_MANAGEMENT=1 VS_PRIVATE_NETWORK=1 \
  CONTROL_API_HOST=0.0.0.0 CONTROL_API_PORT=3000 \
  NODE_ENV=production LIVE_TRADING_ENABLED=false \
  OPERATING_MODE="$OPERATING_MODE" \
  bash -lc "cd '$API' && set -a; [[ -f '$DATA/server.env' ]] && source '$DATA/server.env'; [[ -f '$API/.env' ]] && source '$API/.env'; set +a; export VS_LAN_MANAGEMENT=1 CONTROL_API_HOST=0.0.0.0; exec '$BOOT'" \
  >>"$OUT_LOG" 2>&1 &
echo $! >"$PID_FILE"
set -e

ok=0
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:3000/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

if [[ "$ok" -ne 1 ]]; then
  echo "WARN: service-user start failed — retrying as root" >&2
  if [[ -f "$PID_FILE" ]]; then kill "$(cat "$PID_FILE")" 2>/dev/null || true; fi
  # shellcheck disable=SC1090
  set -a
  [[ -f "$DATA/server.env" ]] && source "$DATA/server.env"
  [[ -f "$API/.env" ]] && source "$API/.env"
  set +a
  export VS_LAN_MANAGEMENT=1 CONTROL_API_HOST=0.0.0.0 CONTROL_API_PORT=3000
  export VS_SERVER_ROOT="$PREFIX" VS_CORE_ROOT="$PREFIX" VS_SERVER_DATA="$DATA" VS_CORE_DATA="$DATA"
  nohup bash "$BOOT" >>"$OUT_LOG" 2>&1 &
  echo $! >"$PID_FILE"
  for i in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:3000/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
fi

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
echo
ss -lntp 2>/dev/null | grep 3000 || true
if [[ "$ok" -ne 1 ]]; then
  echo "FAIL: API still down — last log:" >&2
  tail -80 "$OUT_LOG" >&2 || true
  exit 1
fi

echo "SUCCESS: Control API UP (direct)"
echo "  health: http://127.0.0.1:3000/health"
echo "  LAN:    http://${LAN_IP:-?}:3000/health"
echo "  log:    $OUT_LOG"
echo "  pid:    $(cat "$PID_FILE")"
curl -fsS "http://127.0.0.1:3000/health"; echo
echo "MSI: set VS_SERVER_URL=http://${LAN_IP}:3000 then START_ADMIN.bat"
exit 0
