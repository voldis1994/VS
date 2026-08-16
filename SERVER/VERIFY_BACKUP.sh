#!/usr/bin/env bash
# VERIFY_BACKUP — integrity check of a gzipped pg dump
set -euo pipefail
FILE="${1:-}"
if [[ -z "$FILE" ]]; then
  echo "Usage: VERIFY_BACKUP.sh <path-to-vs-pg-*.sql.gz>" >&2
  exit 2
fi
if [[ ! -f "$FILE" ]]; then
  echo "FAIL: file missing" >&2
  exit 1
fi
if gzip -t "$FILE" 2>/dev/null; then
  BYTES="$(wc -c <"$FILE" | tr -d ' ')"
  if [[ "$BYTES" -lt 32 ]]; then
    echo "FAIL: backup too small ($BYTES bytes)" >&2
    exit 1
  fi
  echo "VERIFIED: $FILE ($BYTES bytes)"
  exit 0
fi
echo "FAIL: gzip integrity" >&2
exit 1
