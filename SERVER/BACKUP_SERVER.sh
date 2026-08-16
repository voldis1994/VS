#!/usr/bin/env bash
# BACKUP_SERVER — PostgreSQL dump + metadata (no secret printing).
set -euo pipefail
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
OUT_DIR="${VS_BACKUP_DIR:-$DATA/backup}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"
if [[ -f "$DATA/server.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DATA/server.env"
  set +a
fi
FILE="$OUT_DIR/vs-pg-$TS.sql.gz"
echo "VS BACKUP → $FILE"
if docker exec market-reader-postgres pg_dump -U "${DB_USER:-market_reader}" "${DB_NAME:-market_reader}" 2>/dev/null | gzip -c >"$FILE"; then
  echo "SUCCESS: $FILE"
  echo "{\"path\":\"$FILE\",\"status\":\"COMPLETED\",\"created_at\":\"$TS\"}" >"$OUT_DIR/vs-pg-$TS.json"
  exit 0
fi
echo "FAIL: pg_dump unavailable" >&2
exit 1
