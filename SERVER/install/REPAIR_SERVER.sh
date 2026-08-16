#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/STATUS_SERVER" || true
bash "$ROOT/install/HEALTHCHECK.sh" || true
echo "REPAIR: re-run INSTALL_SERVER.sh for idempotent fix"
bash "$ROOT/install/INSTALL_SERVER.sh"
