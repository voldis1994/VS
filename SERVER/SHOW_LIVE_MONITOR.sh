#!/usr/bin/env bash
# LIVE terminal status for i3 — stays open, refreshes ~every 0.8s.
# Closing this window does NOT stop the server.
#
#   cd ~/VS-new/VS
#   sudo bash SERVER/SHOW_LIVE_MONITOR.sh
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export VS_MONITOR_REFRESH_MS="${VS_MONITOR_REFRESH_MS:-800}"

# server.env is root-only — use sudo so monitor can authenticate to Control API
if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo --preserve-env=VS_MONITOR_REFRESH_MS,VS_MONITOR_API_URL,CONTROL_API_PORT \
    bash "$HERE/MONITOR_SERVER"
fi
exec bash "$HERE/MONITOR_SERVER"
