#!/usr/bin/env bash
# RESTORE_SERVER — restore PostgreSQL from backup. Requires explicit confirmation.
set -euo pipefail
FILE="${1:-}"
CONFIRM="${2:-}"
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
if [[ -z "$FILE" ]]; then
  echo "Usage: RESTORE_SERVER.sh <backup.sql.gz> CONFIRM" >&2
  exit 2
fi
if [[ "$CONFIRM" != "CONFIRM" ]]; then
  echo "Refusing restore without CONFIRM argument" >&2
  exit 2
fi
if [[ ! -f "$FILE" ]]; then
  echo "FAIL: backup missing" >&2
  exit 1
fi
bash "$(dirname "$0")/VERIFY_BACKUP.sh" "$FILE"
if [[ -f "$DATA/server.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DATA/server.env"
  set +a
fi
echo "Restoring $FILE → database (destructive)"
gunzip -c "$FILE" | docker exec -i market-reader-postgres \
  psql -U "${DB_USER:-market_reader}" -d "${DB_NAME:-market_reader}"
echo "RESTORE COMPLETE"
