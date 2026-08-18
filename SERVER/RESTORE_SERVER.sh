#!/usr/bin/env bash
# RESTORE_SERVER — restore PostgreSQL from backup. Requires explicit confirmation.
# Stops the application service before restore and verifies the database
# is accessible afterwards.
set -euo pipefail
FILE="${1:-}"
CONFIRM="${2:-}"
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"

if [[ -z "$FILE" ]]; then
  echo "Usage: RESTORE_SERVER.sh <backup.sql.gz> CONFIRM" >&2
  exit 2
fi
if [[ "$CONFIRM" != "CONFIRM" ]]; then
  echo "Refusing restore without explicit CONFIRM argument" >&2
  exit 2
fi
if [[ ! -f "$FILE" ]]; then
  echo "FAIL: backup file not found: $FILE" >&2
  exit 1
fi

# Verify backup integrity before touching anything.
bash "$(dirname "$0")/VERIFY_BACKUP.sh" "$FILE"

if [[ -f "$DATA/server.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DATA/server.env"
  set +a
fi

echo "1) Stopping vs-server service to prevent writes during restore..."
systemctl stop vs-server.service 2>/dev/null || true
# Give it a moment to flush in-flight transactions.
sleep 2

echo "2) Restoring $FILE → database (destructive)"
gunzip -c "$FILE" | docker exec -i market-reader-postgres \
  psql -U "${DB_USER:-market_reader}" -d "${DB_NAME:-market_reader}" -v ON_ERROR_STOP=1

echo "3) Post-restore connectivity check..."
TABLES="$(docker exec market-reader-postgres \
  psql -U "${DB_USER:-market_reader}" -d "${DB_NAME:-market_reader}" \
  -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null \
  | tr -d '[:space:]')"
if [[ -z "$TABLES" || "$TABLES" -lt 1 ]]; then
  echo "WARN: post-restore check returned no public tables — inspect manually" >&2
else
  echo "OK: database has $TABLES public tables"
fi

echo "4) Restarting vs-server service..."
systemctl start vs-server.service || echo "WARN: could not restart vs-server — start manually"

echo "RESTORE COMPLETE: $FILE"
