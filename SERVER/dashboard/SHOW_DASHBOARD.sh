#!/usr/bin/env bash
# SHOW_DASHBOARD — local read-only i3 console (does not stop backend on exit).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="$(cd "$HERE/.." && pwd)"
exec bash "$SERVER/MONITOR_SERVER"
