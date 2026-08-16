#!/usr/bin/env bash
# LIVE terminal status for i3 — stays open, refreshes ~every 0.8s.
# Closing this window does NOT stop the server.
#
#   cd ~/VS-new/VS
#   bash SERVER/SHOW_LIVE_MONITOR.sh
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export VS_MONITOR_REFRESH_MS="${VS_MONITOR_REFRESH_MS:-800}"
exec bash "$HERE/MONITOR_SERVER"
