#!/usr/bin/env bash
# Legacy install.sh — delegates to SERVER/INSTALL_SERVER when present.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -x "$HERE/../INSTALL_SERVER" ]]; then
  exec "$HERE/../INSTALL_SERVER" "$@"
fi
echo "FAIL: INSTALL_SERVER missing" >&2
exit 1
