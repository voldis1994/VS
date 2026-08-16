#!/usr/bin/env bash
# Launch VS CORE Server Panel v2 (graphical) — does NOT stop backend on exit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
PORT="${CONTROL_API_PORT:-3000}"
TOKEN=""
if [[ -f "$DATA/server.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DATA/server.env"
  set +a
  TOKEN="${API_ADMIN_TOKEN:-}"
  PORT="${CONTROL_API_PORT:-$PORT}"
fi
# Inject config for local panel
CFG="$HERE/public/config.js"
cat >"$CFG" <<EOF
window.VS_PANEL_CONFIG = {
  base: "http://127.0.0.1:${PORT}",
  token: $(printf '%s' "$TOKEN" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')
};
EOF
INDEX="file://${HERE}/public/index.html"
# Prefer chromium/firefox if available; else python http server + xdg-open
if command -v chromium >/dev/null 2>&1; then
  exec chromium --app="$INDEX" --disable-extensions >/dev/null 2>&1
elif command -v google-chrome >/dev/null 2>&1; then
  exec google-chrome --app="$INDEX" >/dev/null 2>&1
elif command -v xdg-open >/dev/null 2>&1; then
  # Serve via simple static server so fetch works (file:// CORS)
  cd "$HERE/public"
  python3 -m http.server 3977 >/tmp/vs-panel-v2.log 2>&1 &
  sleep 0.4
  exec xdg-open "http://127.0.0.1:3977/"
else
  echo "Open $HERE/public/index.html in a browser"
  echo "Set localStorage VS_API_BASE and VS_ADMIN_TOKEN"
fi
