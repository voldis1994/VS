#!/usr/bin/env bash
# ONE command on i3 to get Control API :3000 healthy.
#   sudo bash SERVER/MAKE_IT_WORK.sh
set -euo pipefail
if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: sudo bash $0" >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
export VS_RESET_PG="${VS_RESET_PG:-1}"

cd "$(cd "$HERE/.." && pwd)"
git pull origin main 2>/dev/null || true

echo "======== MAKE_IT_WORK ========"
systemctl unmask vs-server.service 2>/dev/null || true
docker start market-reader-postgres market-reader-redis 2>/dev/null || true

bash "$HERE/deploy/fix-db-password.sh"
bash "$HERE/FIX_CONTROL_API.sh"

echo
curl -fsS http://127.0.0.1:3000/health
echo
LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
echo "SUCCESS"
echo "LAN IP for MSI: $LAN_IP"
echo "MSI: VS_SERVER_URL=http://${LAN_IP}:3000"
echo "Next: vs-monitor"
exit 0
