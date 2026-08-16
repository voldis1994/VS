#!/usr/bin/env bash
# Canonical installer path requested for physical i3:
#   sudo bash SERVER/install/INSTALL_I3_SERVER.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="$(cd "$HERE/.." && pwd)"
if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: run as root: sudo bash $0" >&2
  exit 1
fi
export LIVE_TRADING_ENABLED=false
exec bash "$SERVER/INSTALL_I3_SERVER" "$@"
