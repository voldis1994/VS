#!/usr/bin/env bash
# Canonical installer entry — wraps existing INSTALL_I3_SERVER (idempotent).
# Does NOT enable LIVE trading.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="$(cd "$HERE/.." && pwd)"
if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: run as root: sudo bash $0" >&2
  exit 1
fi
export LIVE_TRADING_ENABLED=false
exec bash "$SERVER/INSTALL_I3_SERVER" "$@"
