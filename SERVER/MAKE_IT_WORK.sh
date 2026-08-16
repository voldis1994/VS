#!/usr/bin/env bash
# MAKE_IT_WORK — nuclear: one password everywhere + fresh Postgres + start API
#   sudo bash SERVER/MAKE_IT_WORK.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: run as: sudo bash $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PREFIX="${VS_SERVER_PREFIX:-/opt/vs-server}"
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
LOG="${VS_SERVER_LOG:-/var/log/vs-server}"
API="$PREFIX/control-api"
RUN_USER="${VS_SERVER_USER:-vs-server}"
CONTAINER=market-reader-postgres

cd "$REPO"
git pull origin main 2>/dev/null || true

echo "========================================"
echo " MAKE_IT_WORK (nuclear DB + API)"
echo "========================================"

force_kv() {
  local f="$1" k="$2" v="$3"
  mkdir -p "$(dirname "$f")"
  touch "$f"
  if grep -qE "^${k}=" "$f" 2>/dev/null; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >>"$f"
  fi
}

systemctl enable --now docker >/dev/null 2>&1 || true
systemctl stop vs-server.service 2>/dev/null || true
systemctl unmask vs-server.service 2>/dev/null || true
pkill -f 'runAppliance.ts' 2>/dev/null || true
pkill -f 'deploy/boot.sh' 2>/dev/null || true
fuser -k 3000/tcp 2>/dev/null || true

mkdir -p "$PREFIX" "$DATA" "$LOG" "$API"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin "$RUN_USER"
usermod -aG docker "$RUN_USER" 2>/dev/null || true

# Sync code — control-api + core engines (required for market-intelligence exports)
rsync -a --exclude node_modules --exclude dist --exclude data "$HERE/control-api/" "$API/"
rsync -a --exclude node_modules --exclude dist "$HERE/core/" "$PREFIX/core/"
rsync -a "$HERE/deploy/" "$PREFIX/deploy/"
# supervisor / broker helpers used by control-api imports
if [[ -d "$HERE/../SHARED" ]]; then
  rsync -a "$HERE/../SHARED/" "$PREFIX/../SHARED/" 2>/dev/null || true
fi
chmod +x "$PREFIX/deploy/"*.sh
cp -a "$HERE/MONITOR_SERVER" "$PREFIX/MONITOR_SERVER"
install -m 0755 "$HERE/deploy/vs-monitor" /usr/local/bin/vs-monitor

# Prove market-intelligence export exists on disk before boot
if ! grep -q 'buildMarketStateVector' "$PREFIX/core/market-intelligence/src/marketState.ts" 2>/dev/null; then
  echo "FAIL: $PREFIX/core/market-intelligence missing buildMarketStateVector after sync" >&2
  ls -la "$PREFIX/core/market-intelligence/src/" >&2 || true
  exit 1
fi
if ! grep -q "marketState" "$PREFIX/core/market-intelligence/src/index.ts" 2>/dev/null; then
  echo "FAIL: market-intelligence index does not re-export marketState" >&2
  cat "$PREFIX/core/market-intelligence/src/index.ts" >&2 || true
  exit 1
fi

# --- ONE password, write to EVERY env file BEFORE creating DB ---
DB_USER=market_reader
DB_NAME=market_reader
DB_PASSWORD="$(openssl rand -hex 16)"
echo "==> new DB_PASSWORD generated and written to all env files"

for f in "$DATA/server.env" "$DATA/compose.env" "$API/.env" "$PREFIX/.env" "$REPO/.env" /opt/.env; do
  force_kv "$f" DB_HOST 127.0.0.1
  force_kv "$f" DB_PORT 5432
  force_kv "$f" DB_NAME "$DB_NAME"
  force_kv "$f" DB_USER "$DB_USER"
  force_kv "$f" DB_PASSWORD "$DB_PASSWORD"
  force_kv "$f" VS_LAN_MANAGEMENT 1
  force_kv "$f" VS_PRIVATE_NETWORK 1
  force_kv "$f" CONTROL_API_HOST 0.0.0.0
  force_kv "$f" CONTROL_API_PORT 3000
  force_kv "$f" CONTROL_API_URL "http://127.0.0.1:3000"
  force_kv "$f" LIVE_TRADING_ENABLED false
  force_kv "$f" NODE_ENV production
  force_kv "$f" OPERATING_MODE PRODUCTION
  force_kv "$f" VS_SERVER_ROOT "$PREFIX"
  force_kv "$f" VS_CORE_ROOT "$PREFIX"
  force_kv "$f" VS_SERVER_DATA "$DATA"
  force_kv "$f" VS_CORE_DATA "$DATA"
done

# Keep existing secrets if strong; else generate
# shellcheck disable=SC1090
set -a; source "$DATA/server.env"; set +a
if [[ -z "${MASTER_ENCRYPTION_KEY:-}" || "$MASTER_ENCRYPTION_KEY" == *CHANGE_ME* || ${#MASTER_ENCRYPTION_KEY} -lt 32 ]]; then
  K="$(openssl rand -hex 32)"
  for f in "$DATA/server.env" "$API/.env" "$PREFIX/.env" /opt/.env; do force_kv "$f" MASTER_ENCRYPTION_KEY "$K"; done
fi
if [[ -z "${API_ADMIN_TOKEN:-}" || "$API_ADMIN_TOKEN" == CHANGE_ME* ]]; then
  T="$(openssl rand -hex 24)"
  for f in "$DATA/server.env" "$API/.env" "$PREFIX/.env" /opt/.env; do force_kv "$f" API_ADMIN_TOKEN "$T"; done
fi
# Re-assert DB password after sourcing (source could have had old value in memory only)
for f in "$DATA/server.env" "$DATA/compose.env" "$API/.env" "$PREFIX/.env" "$REPO/.env" /opt/.env; do
  force_kv "$f" DB_PASSWORD "$DB_PASSWORD"
  force_kv "$f" DB_USER "$DB_USER"
  force_kv "$f" DB_NAME "$DB_NAME"
done

chmod 600 "$DATA/compose.env" "$API/.env" 2>/dev/null || true
chmod 640 "$DATA/server.env" 2>/dev/null || true

# --- Destroy old Postgres and volume (password baked into volume at first init) ---
echo "==> destroying old Postgres volume (required for password reset)"
VOL="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
docker rm -f "$CONTAINER" 2>/dev/null || true
[[ -n "$VOL" ]] && docker volume rm -f "$VOL" 2>/dev/null || true
for v in $(docker volume ls -q | grep -E 'postgres_data' || true); do
  docker volume rm -f "$v" 2>/dev/null || true
done

if [[ ! -f "$DATA/docker-compose.yml" ]]; then
  cp -a "$REPO/docker-compose.yml" "$DATA/docker-compose.yml"
fi

echo "==> starting fresh Postgres with new password"
docker compose -f "$DATA/docker-compose.yml" --env-file "$DATA/compose.env" up -d postgres \
  || docker run -d --name "$CONTAINER" --restart unless-stopped \
       -e POSTGRES_USER="$DB_USER" \
       -e POSTGRES_PASSWORD="$DB_PASSWORD" \
       -e POSTGRES_DB="$DB_NAME" \
       -p 127.0.0.1:5432:5432 \
       -v vs_postgres_data:/var/lib/postgresql/data \
       postgres:16-alpine

docker start market-reader-redis 2>/dev/null || \
  docker compose -f "$DATA/docker-compose.yml" --env-file "$DATA/compose.env" up -d redis 2>/dev/null || true

echo "==> wait for Postgres"
for i in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U "$DB_USER" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> ensure database $DB_NAME exists"
# During init, healthchecks may log FATAL database does not exist — create explicitly.
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=0 -c \
  "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" \
  || docker exec "$CONTAINER" psql -U "$DB_USER" -d template1 -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" \
  || true

# Also try via TCP once password path works
docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER" \
  psql -h 127.0.0.1 -U "$DB_USER" -d postgres -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" 2>/dev/null || true

echo "==> verify TCP auth + database"
if ! docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER" \
  psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -c 'SELECT 1' >/dev/null; then
  echo "FAIL: cannot SELECT 1 on ${DB_NAME}" >&2
  docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c '\l' >&2 || true
  docker logs "$CONTAINER" 2>&1 | tail -40 >&2
  exit 1
fi
echo "OK: Postgres accepts DB_PASSWORD on database $DB_NAME"

# --- Build CLIENT web portal (market / lot / START STOP) ---
CLIENT_SRC="$REPO/CLIENT/desktop"
CLIENT_DIST="$PREFIX/client-panel"
echo "==> build CLIENT web panel → $CLIENT_DIST"
if [[ -f "$CLIENT_SRC/package.json" ]]; then
  mkdir -p "$CLIENT_DIST" "$PREFIX/client-panel-src"
  rsync -a --delete --exclude node_modules --exclude dist "$CLIENT_SRC/" "$PREFIX/client-panel-src/"
  chown -R "$RUN_USER:$RUN_USER" "$PREFIX/client-panel-src" "$CLIENT_DIST"
  sudo -u "$RUN_USER" bash -lc "cd '$PREFIX/client-panel-src' && (npm ci || npm install) && npm run build"
  rsync -a --delete "$PREFIX/client-panel-src/dist/" "$CLIENT_DIST/"
  chown -R "$RUN_USER:$RUN_USER" "$CLIENT_DIST"
  for f in "$DATA/server.env" "$API/.env"; do
    force_kv "$f" CLIENT_PANEL_DIST "$CLIENT_DIST"
  done
  echo "OK: CLIENT panel built"
else
  echo "WARN: CLIENT/desktop missing — portal UI not built"
fi

# npm if needed for control-api
if [[ ! -x "$API/node_modules/.bin/tsx" ]]; then
  chown -R "$RUN_USER:$RUN_USER" "$API"
  sudo -u "$RUN_USER" bash -lc "cd '$API' && (npm ci || npm install) && npm install tsx@^4.19.0 --save"
fi
chown -R "$RUN_USER:$RUN_USER" "$DATA" "$LOG" "$PREFIX"

# Firewall so MSI LAN can reach :3000
if [[ -x "$HERE/network/APPLY_FIREWALL" ]]; then
  echo "==> APPLY_FIREWALL"
  bash "$HERE/network/APPLY_FIREWALL" || true
else
  ufw allow from 192.168.0.0/16 to any port 3000 proto tcp 2>/dev/null || true
  ufw allow from 10.77.0.0/16 to any port 3000 proto tcp 2>/dev/null || true
fi

# Rewrite systemd (unmask, real file, root prestart)
rm -f /etc/systemd/system/vs-server.service
cat >/etc/systemd/system/vs-server.service <<UNIT
[Unit]
Description=VS SERVER appliance
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${PREFIX}
EnvironmentFile=-${DATA}/server.env
Environment=VS_SERVER_ROOT=${PREFIX}
Environment=VS_CORE_ROOT=${PREFIX}
Environment=VS_SERVER_DATA=${DATA}
Environment=VS_CORE_DATA=${DATA}
Environment=NODE_ENV=production
Environment=OPERATING_MODE=PRODUCTION
Environment=LIVE_TRADING_ENABLED=false
Environment=VS_LAN_MANAGEMENT=1
Environment=VS_PRIVATE_NETWORK=1
Environment=CONTROL_API_HOST=0.0.0.0
Environment=CONTROL_API_PORT=3000
Environment=DB_HOST=127.0.0.1
Environment=DB_PORT=5432
Environment=DB_NAME=${DB_NAME}
Environment=DB_USER=${DB_USER}
Environment=DB_PASSWORD=${DB_PASSWORD}
Environment=CLIENT_PANEL_DIST=${PREFIX}/client-panel
ExecStartPre=+${PREFIX}/deploy/ensure-postgres.sh
ExecStart=${PREFIX}/deploy/boot.sh
Restart=on-failure
RestartSec=5
SupplementaryGroups=docker
NoNewPrivileges=false
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${DATA} ${LOG} ${PREFIX} /var/run/docker.sock

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable vs-server.service
systemctl restart vs-server.service || true

ok=0
for i in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

if [[ "$ok" -ne 1 ]]; then
  echo "WARN: systemd failed — starting API direct with explicit DB env"
  journalctl -u vs-server -n 30 --no-pager >&2 || true
  # shellcheck disable=SC1090
  set -a
  source "$DATA/server.env"
  set +a
  export DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD"
  export VS_LAN_MANAGEMENT=1 CONTROL_API_HOST=0.0.0.0 CONTROL_API_PORT=3000
  export VS_SERVER_ROOT="$PREFIX" VS_CORE_ROOT="$PREFIX" VS_SERVER_DATA="$DATA" VS_CORE_DATA="$DATA"
  export NODE_ENV=production LIVE_TRADING_ENABLED=false
  nohup bash "$PREFIX/deploy/boot.sh" >>"$LOG/api-direct.out" 2>&1 &
  echo $! >"$DATA/vs-api-direct.pid"
  for i in $(seq 1 45); do
    if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
fi

if [[ "$ok" -ne 1 ]]; then
  echo "FAIL: API still down" >&2
  tail -80 "$LOG/api-direct.out" 2>/dev/null >&2 || true
  journalctl -u vs-server -n 40 --no-pager >&2 || true
  exit 1
fi

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
echo
echo "======== SUCCESS — VS SERVER READY ========"
curl -fsS http://127.0.0.1:3000/health; echo
ss -lntp | grep 3000 || true
echo
echo "i3 LAN IP:     $LAN_IP"
echo "Control API:   http://${LAN_IP}:3000/health"
echo "CLIENT portal: http://${LAN_IP}:3000/   (login from ADMIN → CLIENTS)"
echo "WireGuard:     http://10.77.0.1:3000/  (remote clients)"
echo
echo "MSI next:"
echo "  1) git pull"
echo "  2) ADMIN\\START_EVERYTHING.bat"
echo "  3) In ADMIN → CLIENTS → CREATE WEB LOGIN"
echo "  4) Give client the URL + password shown"
echo
echo "Monitor: vs-monitor"
exit 0
