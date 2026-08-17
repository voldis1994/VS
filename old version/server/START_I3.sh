#!/usr/bin/env bash
# =============================================================================
# START_I3 — ONE command on Debian i3: fix DB, start Control API, build CLIENT
#
#   sudo bash SERVER/START_I3.sh
#
# Then on MSI: ADMIN\START_EVERYTHING.bat
# =============================================================================
set -euo pipefail
if [[ "$(id -u)" -ne 0 ]]; then
  echo "FAIL: run as:  sudo bash $0" >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO"
echo "======== START_I3 ========"
git pull origin main 2>/dev/null || true
exec bash "$HERE/MAKE_IT_WORK.sh"
