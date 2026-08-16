#!/usr/bin/env bash
# =============================================================================
# VIENA KOMANDA — i3 serveris
#
#   cd ~/VS-new/VS
#   git pull origin main
#   sudo bash START_I3
#
# =============================================================================
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: palaid ar:  sudo bash START_I3" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "########################################"
echo "#  VS — START_I3 (visa servera palaišana)"
echo "########################################"

git pull origin main 2>/dev/null || true

if [[ ! -x "$ROOT/SERVER/MAKE_IT_WORK.sh" ]]; then
  echo "FAIL: trūkst SERVER/MAKE_IT_WORK.sh — git pull origin main" >&2
  exit 1
fi

bash "$ROOT/SERVER/MAKE_IT_WORK.sh"
rc=$?

if [[ "$rc" -ne 0 ]]; then
  echo "FAIL: MAKE_IT_WORK exit $rc" >&2
  exit "$rc"
fi

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
echo
echo "########################################"
echo "#  GATAVS"
echo "#  LAN IP = ${LAN_IP}"
echo "#  Pārbaude: curl http://127.0.0.1:3000/health"
echo "#  Monitors: vs-monitor"
echo "#  MSI: ieraksti šo IP failā ADMIN\\config\\SERVER_IP.txt"
echo "#       tad palaid START_MSI.bat"
echo "########################################"
exit 0
