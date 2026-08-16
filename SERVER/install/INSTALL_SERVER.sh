#!/usr/bin/env bash
# Canonical installer — COMPLETE physical i3 server (idempotent).
#   sudo bash SERVER/install/INSTALL_SERVER.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="$(cd "$HERE/.." && pwd)"
if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: run as root: sudo bash $0" >&2
  exit 1
fi
export LIVE_TRADING_ENABLED=false

echo "======== INSTALL_SERVER (authoritative) ========"
# Prefer root START_I3 / MAKE_IT_WORK after classic tree install so MI contract + DB are fixed
bash "$SERVER/INSTALL_I3_SERVER" "$@"
# Post-validate MI + health
bash "$SERVER/deploy/validate-mi-contract.sh"
ok=0
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [[ "$ok" -ne 1 ]]; then
  echo "WARN: health not up after INSTALL_I3_SERVER — running MAKE_IT_WORK repair"
  bash "$SERVER/MAKE_IT_WORK.sh"
fi
curl -fsS http://127.0.0.1:3000/health | head -c 500
echo
echo "SUCCESS: INSTALL_SERVER complete"
exit 0
