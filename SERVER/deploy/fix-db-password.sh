#!/usr/bin/env bash
# Sync Postgres password inside market-reader-postgres to match server.env / compose.env.
# Docker volume keeps the FIRST POSTGRES_PASSWORD forever — env file rotations cause 28P01.
#
#   sudo bash SERVER/deploy/fix-db-password.sh
set -euo pipefail

DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
PREFIX="${VS_SERVER_PREFIX:-/opt/vs-server}"
API="${PREFIX}/control-api"
CONTAINER="${VS_PG_CONTAINER:-market-reader-postgres}"

force_kv() {
  local f="$1" k="$2" v="$3"
  [[ -f "$f" ]] || touch "$f"
  if grep -qE "^${k}=" "$f" 2>/dev/null; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >>"$f"
  fi
}

read_kv() {
  local f="$1" k="$2"
  [[ -f "$f" ]] || return 1
  grep -E "^${k}=" "$f" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r'
}

echo "==> fix-db-password"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "FAIL: container $CONTAINER not found — start postgres first" >&2
  exit 1
fi
docker start "$CONTAINER" >/dev/null 2>&1 || true

# Prefer durable appliance env, then compose, then api
DB_USER="$(read_kv "$DATA/server.env" DB_USER || true)"
DB_PASSWORD="$(read_kv "$DATA/server.env" DB_PASSWORD || true)"
DB_NAME="$(read_kv "$DATA/server.env" DB_NAME || true)"
[[ -z "$DB_USER" ]] && DB_USER="$(read_kv "$DATA/compose.env" DB_USER || true)"
[[ -z "$DB_PASSWORD" ]] && DB_PASSWORD="$(read_kv "$DATA/compose.env" DB_PASSWORD || true)"
[[ -z "$DB_NAME" ]] && DB_NAME="$(read_kv "$DATA/compose.env" DB_NAME || true)"
[[ -z "$DB_USER" ]] && DB_USER="$(read_kv "$API/.env" DB_USER || true)"
[[ -z "$DB_PASSWORD" ]] && DB_PASSWORD="$(read_kv "$API/.env" DB_PASSWORD || true)"
[[ -z "$DB_NAME" ]] && DB_NAME="$(read_kv "$API/.env" DB_NAME || true)"

DB_USER="${DB_USER:-market_reader}"
DB_NAME="${DB_NAME:-market_reader}"

if [[ -z "$DB_PASSWORD" || "$DB_PASSWORD" == *CHANGE_ME* || ${#DB_PASSWORD} -lt 8 ]]; then
  DB_PASSWORD="$(openssl rand -hex 16)"
  echo "WARN: generated new DB_PASSWORD (was missing/weak)"
fi

# Write same password everywhere the API/boot might read
for f in "$DATA/server.env" "$DATA/compose.env" "$API/.env" "$PREFIX/.env"; do
  mkdir -p "$(dirname "$f")"
  touch "$f"
  force_kv "$f" DB_HOST 127.0.0.1
  force_kv "$f" DB_PORT 5432
  force_kv "$f" DB_NAME "$DB_NAME"
  force_kv "$f" DB_USER "$DB_USER"
  force_kv "$f" DB_PASSWORD "$DB_PASSWORD"
done
chmod 600 "$DATA/compose.env" "$API/.env" 2>/dev/null || true
chmod 640 "$DATA/server.env" 2>/dev/null || true

# Wait ready (auth not required for pg_isready)
ok=0
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 \
    || docker exec "$CONTAINER" pg_isready >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
[[ "$ok" -eq 1 ]] || { echo "FAIL: postgres not ready" >&2; exit 1; }

# Reset role password via local postgres superuser inside the container (no old password needed)
echo "==> ALTER USER $DB_USER password inside $CONTAINER"
# Escape single quotes for SQL
SQL_PASS="${DB_PASSWORD//\'/\'\'}"
docker exec -u postgres "$CONTAINER" psql -v ON_ERROR_STOP=1 -c \
  "DO \$\$BEGIN
     IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
       CREATE ROLE ${DB_USER} LOGIN PASSWORD '${SQL_PASS}';
     ELSE
       ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${SQL_PASS}';
     END IF;
   END\$\$;"

docker exec -u postgres "$CONTAINER" psql -v ON_ERROR_STOP=1 -c \
  "SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
   WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec" \
  2>/dev/null || docker exec -u postgres "$CONTAINER" psql -c \
  "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" 2>/dev/null || true

# Prove password works from host via TCP (same path as Node)
export PGPASSWORD="$DB_PASSWORD"
if command -v psql >/dev/null 2>&1; then
  if psql -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -c 'SELECT 1' >/dev/null 2>&1; then
    echo "OK: host TCP auth works for $DB_USER@$DB_NAME"
  else
    echo "WARN: psql TCP test failed — trying docker exec password test"
  fi
fi

# Prove via docker + password env
if docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER" \
  psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -c 'SELECT 1' >/dev/null 2>&1; then
  echo "OK: DB password synced (28P01 should be gone)"
  exit 0
fi

echo "FAIL: password still rejected after ALTER ROLE" >&2
exit 1
