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
echo "#  Local:  curl -f http://127.0.0.1:3000/health"
echo "#  LAN:    curl -f http://${LAN_IP}:3000/health"
echo "#  MSI:    ADMIN\\config\\SERVER_IP.txt = ${LAN_IP}"
echo "#          tad START_MSI.bat"
echo "#  Ja MSI neredz: sudo bash SERVER/OPEN_LAN_FOR_MSI.sh"
echo "########################################"

# Fail closed if LAN unreachable from this host
if [[ -n "$LAN_IP" ]] && ! curl -fsS --connect-timeout 3 "http://${LAN_IP}:3000/health" >/dev/null; then
  echo "WARN: LAN health failed — running OPEN_LAN_FOR_MSI" >&2
  bash "$ROOT/SERVER/OPEN_LAN_FOR_MSI.sh"
fi
exit 0
