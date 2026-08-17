#!/usr/bin/env bash
# =============================================================================
# FIX_CONTROL_API — emergency repair: get :3000 healthy on this i3 NOW
#
#   sudo bash SERVER/FIX_CONTROL_API.sh
#   sudo bash SERVER/FIX_CONTROL_API
#
# Does NOT claim LIVE trading. Does NOT invent data.
# Syncs critical files from this git tree → /opt, rewrites systemd, starts API.
# =============================================================================
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: run as root:  sudo bash $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
# Allow SERVER/FIX_CONTROL_API or SERVER/FIX_CONTROL_API.sh
[[ -f "$HERE/INSTALL_I3_SERVER" ]] || HERE="$(cd "$(dirname "$0")/.." && pwd)/SERVER"
REPO="$(cd "$HERE/.." && pwd)"
PREFIX="${VS_SERVER_PREFIX:-/opt/vs-server}"
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
LOG="${VS_SERVER_LOG:-/var/log/vs-server}"
API="$PREFIX/control-api"
RUN_USER="${VS_SERVER_USER:-vs-server}"

echo "========================================"
echo " VS FIX_CONTROL_API"
echo " REPO=$REPO"
echo " PREFIX=$PREFIX"
echo "========================================"

force_kv() {
  local f="$1" k="$2" v="$3"
  touch "$f"
  if grep -qE "^${k}=" "$f" 2>/dev/null; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >>"$f"
  fi
}

# --- 1) Docker postgres/redis ---
echo "==> docker postgres/redis"
systemctl enable --now docker >/dev/null 2>&1 || true
if [[ -f "$DATA/docker-compose.yml" ]]; then
  bash "$HERE/deploy/ensure-postgres.sh" || {
    docker start market-reader-postgres market-reader-redis 2>/dev/null || true
  }
else
  docker start market-reader-postgres market-reader-redis 2>/dev/null || true
  if [[ -f "$REPO/SERVER/database/docker-compose.yml" ]]; then
    mkdir -p "$DATA"
    cp -a "$REPO/SERVER/database/docker-compose.yml" "$DATA/docker-compose.yml"
    if [[ -f "$REPO/.env" ]]; then
      cp -a "$REPO/.env" "$DATA/compose.env"
    elif [[ -f "$DATA/server.env" ]]; then
      cp -a "$DATA/server.env" "$DATA/compose.env"
    fi
    bash "$HERE/deploy/ensure-postgres.sh" || true
  fi
fi

# --- 1b) Fix 28P01: sync Postgres role password to server.env ---
echo "==> sync DB password (fix 28P01 auth_failed)"
bash "$HERE/deploy/fix-db-password.sh"

# --- 2) Sync critical runtime from git tree (no full wipe) ---
echo "==> sync control-api + core + deploy from git → $PREFIX"
mkdir -p "$PREFIX" "$DATA" "$LOG" "$API" "$PREFIX/core"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin "$RUN_USER"

rsync -a \
  --exclude node_modules \
  --exclude dist \
  --exclude data \
  "$HERE/control-api/" "$API/"
rsync -a --exclude node_modules --exclude dist "$HERE/core/" "$PREFIX/core/"
mkdir -p "$PREFIX/deploy" "$PREFIX/network"
rsync -a "$HERE/deploy/" "$PREFIX/deploy/"
rsync -a "$HERE/network/" "$PREFIX/network/" 2>/dev/null || true
cp -a "$HERE/MONITOR_SERVER" "$PREFIX/MONITOR_SERVER"
rsync -a --delete --exclude '__pycache__' "$HERE/monitor/" "$PREFIX/monitor/" 2>/dev/null || true
cp -a "$HERE/SHOW_LIVE_MONITOR.sh" "$PREFIX/SHOW_LIVE_MONITOR.sh" 2>/dev/null || true
cp -a "$HERE/STATUS_SERVER" "$PREFIX/STATUS_SERVER" 2>/dev/null || true
cp -a "$HERE/START_SERVER" "$PREFIX/START_SERVER" 2>/dev/null || true
cp -a "$HERE/STOP_SERVER" "$PREFIX/STOP_SERVER" 2>/dev/null || true
chmod +x "$PREFIX/deploy/"*.sh "$PREFIX/MONITOR_SERVER" "$PREFIX/deploy/boot.sh" \
  "$PREFIX/deploy/ensure-postgres.sh" 2>/dev/null || true

install -m 0755 "$HERE/deploy/vs-monitor" /usr/local/bin/vs-monitor

if ! grep -q 'buildMarketStateVector' "$PREFIX/core/market-intelligence/src/marketState.ts" 2>/dev/null; then
  echo "FAIL: core/market-intelligence not synced (buildMarketStateVector missing)" >&2
  exit 1
fi
chmod +x "$PREFIX/deploy/validate-mi-contract.sh" 2>/dev/null || true
echo "==> validate market-intelligence ESM contract"
bash "$PREFIX/deploy/validate-mi-contract.sh"

# --- 3) Force LAN bind in every env file ---
echo "==> force CONTROL_API_HOST=0.0.0.0"
for f in "$DATA/server.env" "$API/.env" "$PREFIX/.env" "$REPO/.env"; do
  [[ -f "$f" ]] || continue
  force_kv "$f" VS_LAN_MANAGEMENT 1
  force_kv "$f" VS_PRIVATE_NETWORK 1
  force_kv "$f" CONTROL_API_HOST 0.0.0.0
  force_kv "$f" CONTROL_API_PORT 3000
  force_kv "$f" CONTROL_API_URL "http://127.0.0.1:3000"
  force_kv "$f" LIVE_TRADING_ENABLED false
done

# Ensure MASTER_ENCRYPTION_KEY exists (boot refuses unsafe/missing)
if [[ -f "$DATA/server.env" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$DATA/server.env"; set +a
fi
if [[ -z "${MASTER_ENCRYPTION_KEY:-}" || "$MASTER_ENCRYPTION_KEY" == *CHANGE_ME* || ${#MASTER_ENCRYPTION_KEY} -lt 32 ]]; then
  NEW_KEY="$(openssl rand -hex 32)"
  force_kv "$DATA/server.env" MASTER_ENCRYPTION_KEY "$NEW_KEY"
  force_kv "$API/.env" MASTER_ENCRYPTION_KEY "$NEW_KEY"
  echo "WARN: generated new MASTER_ENCRYPTION_KEY (previous missing/unsafe)"
fi
if [[ -z "${API_ADMIN_TOKEN:-}" || "$API_ADMIN_TOKEN" == "CHANGE_ME_ADMIN_TOKEN" ]]; then
  NEW_TOK="$(openssl rand -hex 24)"
  force_kv "$DATA/server.env" API_ADMIN_TOKEN "$NEW_TOK"
  force_kv "$API/.env" API_ADMIN_TOKEN "$NEW_TOK"
  echo "WARN: generated new API_ADMIN_TOKEN"
fi

chmod 640 "$DATA/server.env" 2>/dev/null || true
chmod 600 "$API/.env" 2>/dev/null || true
chown -R "$RUN_USER:$RUN_USER" "$DATA" "$LOG" "$PREFIX"

# --- 4) npm deps if tsx missing ---
if [[ ! -x "$API/node_modules/.bin/tsx" && ! -d "$API/node_modules/tsx" ]]; then
  echo "==> npm install (tsx missing)"
  sudo -u "$RUN_USER" bash -lc "cd '$API' && (npm ci || npm install) && npm install tsx@^4.19.0 --save"
fi

# --- 5) Rewrite systemd unit (unmask first — masked = symlink to /dev/null) ---
echo "==> rewrite vs-server.service"
systemctl stop vs-server.service 2>/dev/null || true
systemctl disable vs-server.service 2>/dev/null || true
systemctl unmask vs-server.service 2>/dev/null || true
systemctl unmask vs-server-monitor.service 2>/dev/null || true
rm -f /etc/systemd/system/vs-server.service
if [[ -L /etc/systemd/system/vs-server.service ]]; then
  rm -f /etc/systemd/system/vs-server.service
fi

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
# '+' = run prestart as root so docker.sock works (vs-server user often cannot)
ExecStartPre=+${PREFIX}/deploy/ensure-postgres.sh
ExecStart=${PREFIX}/deploy/boot.sh
Restart=on-failure
RestartSec=5
MemoryMax=4G
LimitNOFILE=65535
SupplementaryGroups=docker
NoNewPrivileges=false
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${DATA} ${LOG} ${PREFIX} /var/run/docker.sock

[Install]
WantedBy=multi-user.target
UNIT

if [[ -L /etc/systemd/system/vs-server.service ]] || [[ ! -s /etc/systemd/system/vs-server.service ]]; then
  echo "FAIL: could not write real vs-server.service (masked symlink?)" >&2
  ls -la /etc/systemd/system/vs-server.service >&2 || true
  exit 1
fi

systemctl daemon-reload
systemctl enable vs-server.service
# Ensure docker group membership is effective for the service
usermod -aG docker "$RUN_USER" 2>/dev/null || true
echo "==> restart vs-server"
systemctl restart vs-server.service || true

# --- 6) Wait for health ---
echo "==> wait for /health"
ok=0
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:3000/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done

if [[ "$ok" -ne 1 ]]; then
  echo "WARN: systemd path failed — falling back to START_API_DIRECT" >&2
  journalctl -u vs-server -n 40 --no-pager >&2 || true
  bash "$HERE/START_API_DIRECT.sh"
  ok=1
fi

echo
echo "======== RESULT ========"
systemctl is-active vs-server.service 2>/dev/null || true
ss -lntp 2>/dev/null | grep -E ':3000\b' || netstat -lntp 2>/dev/null | grep 3000 || true

if ! curl -fsS "http://127.0.0.1:3000/health" >/dev/null 2>&1; then
  echo "FAIL: Control API still down on 127.0.0.1:3000" >&2
  exit 1
fi

echo "OK: /health"
curl -fsS "http://127.0.0.1:3000/health" || true
echo
if curl -fsS "http://127.0.0.1:3000/api/v1/server/monitor/console/text" | head -8; then
  echo "OK: monitor console"
else
  echo "WARN: /health OK but monitor console failed — check auth middleware deploy"
fi

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
echo
echo "==> open LAN firewall for MSI"
bash "$HERE/network/APPLY_FIREWALL" || true
if [[ -n "$LAN_IP" ]]; then
  if ! curl -fsS --connect-timeout 3 "http://${LAN_IP}:3000/health" >/dev/null; then
    echo "WARN: LAN health failed — OPEN_LAN_FOR_MSI" >&2
    bash "$HERE/OPEN_LAN_FOR_MSI.sh" || true
  fi
  curl -fsS --connect-timeout 3 "http://${LAN_IP}:3000/health" || true
  echo
fi
echo "SUCCESS: Control API listening"
echo "  Local:  http://127.0.0.1:3000/health"
echo "  LAN:    http://${LAN_IP:-<lan-ip>}:3000/health"
echo "  MSI:    ADMIN\\config\\SERVER_IP.txt = ${LAN_IP}"
echo "          then START_MSI.bat"
echo "NEXT:     vs-monitor"
exit 0
