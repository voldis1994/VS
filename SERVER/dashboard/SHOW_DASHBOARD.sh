#!/usr/bin/env bash
# SHOW_DASHBOARD — local read-only i3 console (does not stop backend on exit).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -x "$HERE/MONITOR_SERVER" ]]; then
  exec bash "$HERE/MONITOR_SERVER"
fi
if [[ -x "$HERE/dashboard/SHOW_DASHBOARD.sh" ]]; then
  exec bash "$HERE/dashboard/SHOW_DASHBOARD.sh"
fi
echo "MONITOR_SERVER not found under $HERE" >&2
exit 1
