#!/usr/bin/env bash
# OPEN_LAN_FOR_MSI — force Control API reachable from MSI on home Wi-Fi.
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
  force_kv "$f" CONTROL_API_HOST 0.0.0.0
  force_kv "$f" CONTROL_API_PORT "$API_PORT"
done

bash "$HERE/network/APPLY_FIREWALL" || true

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
if ss -lntp | grep -E ":${API_PORT}\\b" | grep -qE '127\.0\.0\.1|\[::1\]'; then
  if ! ss -lntp | grep -E ":${API_PORT}\\b" | grep -qE '0\.0\.0\.0|\*:|\[::\]'; then
    echo "FAIL: Control API bound to localhost only — MSI cannot connect" >&2
    ss -lntp | grep -E ":${API_PORT}\\b" >&2 || true
    exit 1
  fi
fi

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

echo "==> LAN health via ${LAN_IP}:"
if ! curl -fsS --connect-timeout 3 "http://${LAN_IP}:${API_PORT}/health"; then
  echo >&2
  echo "FAIL: LAN IP /health failed — bind/firewall still wrong" >&2
  exit 1
fi
echo

echo "======== MSI COPY THESE ========"
echo "1) On MSI create file ADMIN\\config\\SERVER_IP.txt with ONE line:"
echo "   ${LAN_IP}"
echo "2) git pull"
echo "3) START_MSI.bat"
echo "Test from MSI PowerShell:"
echo "   curl.exe -s http://${LAN_IP}:${API_PORT}/health"
echo "SUCCESS: LAN API open for MSI"
exit 0
