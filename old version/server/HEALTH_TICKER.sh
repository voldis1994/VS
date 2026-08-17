#!/usr/bin/env bash
# Lightweight always-on health ticker (no full VS CORE frame).
# Use when MONITOR_SERVER/tsx is unavailable.
#
#   watch -n 0.5 'curl -fsS http://127.0.0.1:3000/health && echo && date -u'
#
set -euo pipefail
URL="${VS_MONITOR_API_URL:-http://127.0.0.1:3000}/health"
INTERVAL="${VS_HEALTH_TICK_SEC:-0.5}"
echo "VS health ticker → $URL  (Ctrl+C stops ticker only, not the server)"
if command -v watch >/dev/null 2>&1; then
  exec watch -n "$INTERVAL" "curl -fsS '$URL' 2>&1; echo; date -u '+%Y-%m-%d %H:%M:%S UTC'"
fi
while true; do
  clear
  date -u '+%Y-%m-%d %H:%M:%S UTC'
  curl -fsS "$URL" 2>&1 || echo "OFFLINE"
  echo
  echo "(refresh ${INTERVAL}s — Ctrl+C to exit)"
  sleep "$INTERVAL"
done
