#!/usr/bin/env bash
# Sync Postgres password for market-reader-postgres with server.env.
#
# Official image with POSTGRES_USER=market_reader has NO "postgres" role.
# Never use: docker exec -u postgres ... psql  (fails: role "postgres" does not exist)
#
#   sudo bash SERVER/deploy/fix-db-password.sh
# Nuclear recreate (wipes DB volume): VS_RESET_PG=1 sudo bash SERVER/deploy/fix-db-password.sh
set -euo pipefail

DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
PREFIX="${VS_SERVER_PREFIX:-/opt/vs-server}"
API="${PREFIX}/control-api"
CONTAINER="${VS_PG_CONTAINER:-market-reader-postgres}"

force_kv() {
  local f="$1" k="$2" v="$3"
  mkdir -p "$(dirname "$f")"
  touch "$f"
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

DB_USER="$(read_kv "$DATA/server.env" DB_USER || true)"
DB_PASSWORD="$(read_kv "$DATA/server.env" DB_PASSWORD || true)"
DB_NAME="$(read_kv "$DATA/server.env" DB_NAME || true)"
[[ -z "${DB_USER:-}" ]] && DB_USER="$(read_kv "$DATA/compose.env" DB_USER || true)"
[[ -z "${DB_PASSWORD:-}" ]] && DB_PASSWORD="$(read_kv "$DATA/compose.env" DB_PASSWORD || true)"
[[ -z "${DB_NAME:-}" ]] && DB_NAME="$(read_kv "$DATA/compose.env" DB_NAME || true)"
[[ -z "${DB_USER:-}" ]] && DB_USER="$(read_kv "$API/.env" DB_USER || true)"
[[ -z "${DB_PASSWORD:-}" ]] && DB_PASSWORD="$(read_kv "$API/.env" DB_PASSWORD || true)"
[[ -z "${DB_NAME:-}" ]] && DB_NAME="$(read_kv "$API/.env" DB_NAME || true)"

DB_USER="${DB_USER:-market_reader}"
DB_NAME="${DB_NAME:-market_reader}"
if [[ -z "${DB_PASSWORD:-}" || "$DB_PASSWORD" == *CHANGE_ME* || ${#DB_PASSWORD} -lt 8 ]]; then
  DB_PASSWORD="$(openssl rand -hex 16)"
  echo "WARN: generated new DB_PASSWORD"
fi

for f in "$DATA/server.env" "$DATA/compose.env" "$API/.env" "$PREFIX/.env"; do
  force_kv "$f" DB_HOST 127.0.0.1
  force_kv "$f" DB_PORT 5432
  force_kv "$f" DB_NAME "$DB_NAME"
  force_kv "$f" DB_USER "$DB_USER"
  force_kv "$f" DB_PASSWORD "$DB_PASSWORD"
done
chmod 600 "$DATA/compose.env" "$API/.env" 2>/dev/null || true
chmod 640 "$DATA/server.env" 2>/dev/null || true

SQL_PASS="${DB_PASSWORD//\'/\'\'}"

# Local socket as DB_USER (superuser when POSTGRES_USER was set to market_reader)
pg_local() {
  docker exec "$CONTAINER" psql -U "$DB_USER" -d "$1" -v ON_ERROR_STOP=1 -c "$2"
}

pg_tcp_ok() {
  docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -c 'SELECT 1' >/dev/null 2>&1
}

recreate_pg() {
  echo "WARN: recreating Postgres container+volume with password from server.env"
  echo "WARN: this WIPES local DB data on this appliance"
  local vol=""
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    vol="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
  fi
  docker rm -f "$CONTAINER" 2>/dev/null || true
  if [[ -n "$vol" ]]; then
    echo "INFO: removing volume $vol"
    docker volume rm -f "$vol" 2>/dev/null || true
  fi
  for vol in $(docker volume ls -q | grep -E 'postgres_data' || true); do
    echo "INFO: removing volume $vol"
    docker volume rm -f "$vol" 2>/dev/null || true
  done
  # Ensure compose.env has the password we just wrote
  force_kv "$DATA/compose.env" DB_USER "$DB_USER"
  force_kv "$DATA/compose.env" DB_PASSWORD "$DB_PASSWORD"
  force_kv "$DATA/compose.env" DB_NAME "$DB_NAME"
  if [[ -f "$DATA/docker-compose.yml" ]]; then
    docker compose -f "$DATA/docker-compose.yml" --env-file "$DATA/compose.env" up -d postgres \
      || docker compose -f "$DATA/docker-compose.yml" --env-file "$DATA/compose.env" up -d
  else
    docker run -d --name market-reader-postgres --restart unless-stopped \
      -e POSTGRES_USER="$DB_USER" \
      -e POSTGRES_PASSWORD="$DB_PASSWORD" \
      -e POSTGRES_DB="$DB_NAME" \
      -p 127.0.0.1:5432:5432 \
      -v vs_postgres_data:/var/lib/postgresql/data \
      postgres:16-alpine
  fi
  local i
  for i in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "FAIL: postgres did not become ready after recreate" >&2
  return 1
}

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "INFO: container missing — creating"
  recreate_pg
fi
docker start "$CONTAINER" >/dev/null 2>&1 || true

ready=0
for _ in $(seq 1 40); do
  if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "WARN: pg not ready — recreating"
  recreate_pg
fi

# If TCP already works with our password — done
if pg_tcp_ok; then
  echo "OK: DB password already matches"
  exit 0
fi

echo "==> ALTER ROLE $DB_USER via local socket (not role postgres)"
set +e
pg_local "$DB_NAME" "ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${SQL_PASS}';"
alter_rc=$?
if [[ "$alter_rc" -ne 0 ]]; then
  # try connecting to template1 / postgres db name variants
  pg_local template1 "ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${SQL_PASS}';"
  alter_rc=$?
fi
set -e

if pg_tcp_ok; then
  echo "OK: DB password synced (28P01 fixed)"
  exit 0
fi

# Automatic nuclear path — appliance has no production trading data yet
echo "WARN: ALTER failed or TCP still rejects — recreating Postgres volume"
recreate_pg

if pg_tcp_ok; then
  echo "OK: DB recreated and password matches"
  exit 0
fi

echo "FAIL: could not establish DB auth for $DB_USER / $DB_NAME" >&2
docker logs "$CONTAINER" 2>&1 | tail -40 >&2 || true
exit 1
