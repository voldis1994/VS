#!/usr/bin/env bash
# Launch native VS Server Monitor. Closing does NOT stop the backend.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export VS_MONITOR_API_URL="${VS_MONITOR_API_URL:-http://127.0.0.1:${CONTROL_API_PORT:-3000}}"
if [[ -f "$HERE/main.py" ]]; then
  exec python3 "$HERE/main.py"
fi
echo "monitor/main.py missing — MONITOR_SERVER fallback"
exec bash "$HERE/../MONITOR_SERVER"
