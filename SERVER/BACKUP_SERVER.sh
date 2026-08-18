#!/usr/bin/env bash
# BACKUP_SERVER — PostgreSQL dump + metadata (no secret printing).
# Writes to a temporary file first, then atomically renames it so a partial
# dump is never left as the live backup.  Verifies integrity after rename.
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
TMP="$OUT_DIR/.vs-pg-$TS.sql.gz.tmp"
echo "VS BACKUP → $FILE"

# Dump into a temp file so a failed/partial dump never replaces a good backup.
if ! docker exec market-reader-postgres pg_dump \
       -U "${DB_USER:-market_reader}" "${DB_NAME:-market_reader}" 2>/dev/null \
     | gzip -c >"$TMP"; then
  rm -f "$TMP"
  echo "FAIL: pg_dump unavailable or failed" >&2
  exit 1
fi

# Sanity: reject an empty or suspiciously small dump.
BYTES="$(stat -c%s "$TMP" 2>/dev/null || stat -f%z "$TMP" 2>/dev/null || echo 0)"
if [[ "$BYTES" -lt 512 ]]; then
  rm -f "$TMP"
  echo "FAIL: dump is only ${BYTES} bytes — refusing to overwrite good backup" >&2
  exit 1
fi

# Verify gzip integrity before promoting the file.
if ! gzip -t "$TMP" 2>/dev/null; then
  rm -f "$TMP"
  echo "FAIL: gzip integrity check failed on dump" >&2
  exit 1
fi

# Atomic rename: never leave a partial file at the final path.
mv "$TMP" "$FILE"

echo "SUCCESS: $FILE (${BYTES} bytes)"
echo "{\"path\":\"$FILE\",\"status\":\"COMPLETED\",\"created_at\":\"$TS\",\"bytes\":$BYTES}" \
  >"$OUT_DIR/vs-pg-$TS.json"
