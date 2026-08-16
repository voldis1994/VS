#!/usr/bin/env bash
set -euo pipefail
echo "UNINSTALL_SERVER — stops vs-server and leaves data intact unless DESTROY_DATA=1"
systemctl stop vs-server.service 2>/dev/null || true
systemctl disable vs-server.service 2>/dev/null || true
if [[ "${DESTROY_DATA:-}" == "1" ]]; then
  echo "DESTROY_DATA=1 not auto-executed — operator must wipe /var/lib/vs-server manually"
fi
echo "Services stopped/disabled. Data directories preserved."
