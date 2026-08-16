#!/usr/bin/env bash
# Ensure postgres/redis are up before vs-server Control API starts.
# Idempotent: adopts existing market-reader-* containers on name conflict.
set -euo pipefail

DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
COMPOSE_FILE="${DATA}/docker-compose.yml"
ENV_FILE="${DATA}/compose.env"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "FAIL: missing $COMPOSE_FILE" >&2
  exit 1
fi

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  else
    docker-compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  fi
}

err="$(mktemp)"
set +e
compose up -d >"$err" 2>&1
rc=$?
set -e
if [[ "$rc" -ne 0 ]]; then
  if grep -qiE 'already in use|Conflict' "$err"; then
    echo "WARN: compose name conflict — starting market-reader-postgres/redis"
    docker start market-reader-postgres >/dev/null 2>&1 || true
    docker start market-reader-redis >/dev/null 2>&1 || true
  else
    echo "FAIL: docker compose up failed:" >&2
    cat "$err" >&2
    rm -f "$err"
    exit 1
  fi
fi
rm -f "$err"

for _ in $(seq 1 30); do
  if docker exec market-reader-postgres pg_isready >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

echo "FAIL: postgres not ready after 30s" >&2
exit 1
