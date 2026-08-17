#!/usr/bin/env bash
# Launch native VS Server Monitor. Closing does NOT stop the backend.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export VS_MONITOR_API_URL="${VS_MONITOR_API_URL:-http://127.0.0.1:${CONTROL_API_PORT:-3000}}"
if python3 -c "import PySide6" >/dev/null 2>&1 && [[ -f "$HERE/main.py" ]]; then
  exec python3 "$HERE/main.py"
fi
echo "PySide6 not available — falling back to MONITOR_SERVER TUI"
exec bash "$HERE/../MONITOR_SERVER"
