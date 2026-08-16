#!/usr/bin/env bash
# SHOW_DASHBOARD — i3 VS CORE monitor (graphical panel preferred; console fallback).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -x "$HERE/monitor/SHOW_PANEL.sh" || -f "$HERE/monitor/SHOW_PANEL.sh" ]]; then
  exec bash "$HERE/monitor/SHOW_PANEL.sh"
fi
if [[ -x "$HERE/MONITOR_SERVER" ]]; then
  exec bash "$HERE/MONITOR_SERVER"
fi
echo "No SERVER monitor found under $HERE/monitor or MONITOR_SERVER" >&2
exit 1
