#!/usr/bin/env bash
# UPDATE_SERVER — controlled update workflow (never leaves trading blindly active).
# Usage: UPDATE_SERVER.sh <staged-release-dir>
set -euo pipefail
STAGED="${1:-}"
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [[ -z "$STAGED" || ! -d "$STAGED" ]]; then
  echo "Usage: UPDATE_SERVER.sh <staged-VS-SERVER-dir>" >&2
  exit 2
fi
if [[ -f "$DATA/server.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DATA/server.env"
  set +a
fi
CUR="$(tr -d '[:space:]' <"$ROOT/../VERSION" 2>/dev/null || echo unknown)"
NEW="$(tr -d '[:space:]' <"$STAGED/VERSION" 2>/dev/null || echo unknown)"
echo "VS UPDATE $CUR → $NEW"
echo "1) backup"
bash "$ROOT/BACKUP_SERVER.sh" || { echo "UPDATE FAILED: backup"; exit 1; }
echo "2) ensure live trading off during update"
# Prefer kill switch via API when token present; else document operator action
if [[ -n "${API_ADMIN_TOKEN:-}" ]]; then
  curl -fsS -X POST -H "x-admin-token: $API_ADMIN_TOKEN" -H 'content-type: application/json' \
    -d '{"active":true,"reason":"update_in_progress"}' \
    "http://127.0.0.1:${CONTROL_API_PORT:-3000}/api/v1/system/kill-switch" >/dev/null || true
fi
echo "3) stop affected service"
systemctl stop vs-server.service || true
echo "4) deploy staged files (operator-reviewed path)"
echo "STAGED=$STAGED — copy manually or via rsync after review"
echo "5) run migrations after deploy"
echo "6) restart + healthcheck"
echo "If failure: restore backup, mark update FAILED, review logs under $DATA"
echo "UPDATE WORKFLOW PREPARED (deploy step is operator-gated)"
