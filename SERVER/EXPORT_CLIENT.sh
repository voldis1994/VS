#!/usr/bin/env bash
# EXPORT_CLIENT — export enrollment/install package metadata for one client device.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="${VS_SERVER_DATA:-/var/lib/vs-server}"
CLIENT_ID="${1:-}"
if [[ -z "$CLIENT_ID" ]]; then
  echo "Usage: $0 <client_id|device_id>" >&2
  exit 2
fi
OUT="${2:-$DATA/exports/client-$CLIENT_ID-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
BASE="${CONTROL_API_URL:-http://127.0.0.1:3000}"
TOKEN="${API_ADMIN_TOKEN:-}"
if [[ -f "$DATA/server.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DATA/server.env"
  set +a
  TOKEN="${API_ADMIN_TOKEN:-$TOKEN}"
  BASE="http://127.0.0.1:${CONTROL_API_PORT:-3000}"
fi
if [[ -z "$TOKEN" ]]; then
  echo "FAIL: API_ADMIN_TOKEN not set" >&2
  exit 1
fi
echo "Creating CLIENT enrollment package for $CLIENT_ID ..."
RESP=$(curl -fsS -X POST "$BASE/api/v1/network/enrollment/create" \
  -H "content-type: application/json" \
  -H "x-admin-token: $TOKEN" \
  -d "{\"device_type\":\"CLIENT\",\"device_id\":\"$CLIENT_ID\"}") || {
  echo "FAIL: enrollment create" >&2
  exit 1
}
printf '%s\n' "$RESP" >"$OUT/enrollment.json"
# Never write private keys here if server returns them transiently — strip common secret fields
python3 - <<'PY' "$OUT/enrollment.json" || true
import json,sys
p=sys.argv[1]
d=json.load(open(p))
for k in list(d.keys()):
  if any(x in k.lower() for x in ('private','secret','pem')):
    d[k]='[REDACTED]'
json.dump(d, open(p,'w'), indent=2)
print('sanitized', p)
PY
echo "EXPORT OK: $OUT"
echo "Deliver enrollment.json + WireGuard peer material via secure channel."
echo "Customer runs CLIENT\\INSTALL_CLIENT.bat — no Git/Node required for packaged releases."
