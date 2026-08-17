#!/usr/bin/env bash
# OPEN_LAN_FOR_MSI — force Control API reachable from MSI.
#   sudo bash SERVER/OPEN_LAN_FOR_MSI.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: sudo bash $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${VS_SERVER_PREFIX:-/opt/vs-server}"
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
API_PORT="${CONTROL_API_PORT:-3000}"

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

echo "======== OPEN_LAN_FOR_MSI ========"

for f in "$DATA/server.env" "$PREFIX/control-api/.env" "$PREFIX/.env"; do
  force_kv "$f" VS_LAN_MANAGEMENT 1
  force_kv "$f" VS_LAN_TRUST_ADMIN 1
  force_kv "$f" CONTROL_API_HOST 0.0.0.0
  force_kv "$f" CONTROL_API_PORT "$API_PORT"
done

bash "$HERE/network/APPLY_FIREWALL" || true

# Also punch host firewalld if present
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --add-port=443/tcp --permanent 2>/dev/null || true
  firewall-cmd --reload 2>/dev/null || true
fi

systemctl daemon-reload 2>/dev/null || true
systemctl restart vs-server.service || true

ok=0
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[[ "$ok" -eq 1 ]] || { echo "FAIL: localhost /health down" >&2; journalctl -u vs-server -n 40 --no-pager >&2 || true; exit 1; }

echo "==> listen sockets:"
ss -lntp | grep -E ":${API_PORT}\\b" || true
if ! ss -lntp | grep -E ":${API_PORT}\\b" | grep -qE '0\.0\.0\.0|\*:|\[::\]'; then
  echo "FAIL: Control API not on 0.0.0.0 — MSI cannot connect" >&2
  exit 1
fi

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

echo "==> LAN health via ${LAN_IP}:"
curl -fsS --connect-timeout 3 "http://${LAN_IP}:${API_PORT}/health"
echo

# Write IP helper file into repo tree if present (operator may copy to USB)
REPO_HINT="$(cd "$HERE/.." 2>/dev/null && pwd || true)"
if [[ -n "$REPO_HINT" && -d "$REPO_HINT/ADMIN/config" ]]; then
  printf '%s\n' "$LAN_IP" >"$REPO_HINT/ADMIN/config/SERVER_IP.txt"
  echo "Wrote $REPO_HINT/ADMIN/config/SERVER_IP.txt = $LAN_IP"
fi

echo "======== MSI — COPY EXACTLY ========"
echo "cd /d C:\\VS-main"
echo "mkdir ADMIN\\config 2>nul"
echo "echo ${LAN_IP}> ADMIN\\config\\SERVER_IP.txt"
echo "git pull origin main"
echo "START_MSI.bat"
echo
echo "If START_MSI ping/identity FAILS = WiFi AP isolation / wrong IP (not VS bug)."
echo "Fix router: disable AP/client isolation, OR use ethernet, OR WireGuard."
echo "SUCCESS: LAN API open for MSI (i3 side)"
exit 0
