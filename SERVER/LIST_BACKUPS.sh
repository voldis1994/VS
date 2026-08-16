#!/usr/bin/env bash
# LIST_BACKUPS — list VS backup artifacts
set -euo pipefail
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
OUT_DIR="${VS_BACKUP_DIR:-$DATA/backup}"
mkdir -p "$OUT_DIR"
echo "VS BACKUPS in $OUT_DIR"
shopt -s nullglob
files=("$OUT_DIR"/vs-pg-*.sql.gz)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "NO DATA"
  exit 0
fi
ls -lh "${files[@]}" | awk '{print $5, $6, $7, $8, $9}'
