#!/usr/bin/env bash
# LIVE terminal status for i3 — stays open, refreshes ~every 0.8s.
# Closing this window does NOT stop the server.
#
#   vs-monitor
#   sudo bash SERVER/SHOW_LIVE_MONITOR.sh
#
# Does NOT require sourcing /var/lib/vs-server/server.env.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export VS_MONITOR_REFRESH_MS="${VS_MONITOR_REFRESH_MS:-800}"
export VS_SERVER_PREFIX="${VS_SERVER_PREFIX:-/opt/vs-server}"
export VS_SERVER_ROOT="${VS_SERVER_ROOT:-$VS_SERVER_PREFIX}"
export VS_SERVER_DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"

# Prefer installed appliance tree; fall back to repo scripts.
TARGET="$HERE/MONITOR_SERVER"
if [[ -x /opt/vs-server/MONITOR_SERVER ]]; then
  TARGET=/opt/vs-server/MONITOR_SERVER
elif [[ -x "$VS_SERVER_PREFIX/MONITOR_SERVER" ]]; then
  TARGET="$VS_SERVER_PREFIX/MONITOR_SERVER"
fi

if [[ ! -x "$TARGET" && -f "$TARGET" ]]; then
  chmod +x "$TARGET" || true
fi

if [[ ! -f "$TARGET" ]]; then
  echo "FAIL: MONITOR_SERVER missing at $TARGET" >&2
  exit 1
fi

exec bash "$TARGET"
