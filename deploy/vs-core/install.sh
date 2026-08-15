#!/usr/bin/env bash
# Install VS CORE onto a minimal Linux host (Debian/Ubuntu target).
# Does NOT build a custom kernel — uses host systemd + Node 20+.
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
PREFIX="${VS_CORE_PREFIX:-/opt/vs-core}"
DATA="${VS_CORE_DATA:-/var/lib/vs-core}"
LOG="${VS_CORE_LOG:-/var/log/vs-core}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root for system install" >&2
  exit 1
fi

id -u vs-core >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin vs-core
mkdir -p "$PREFIX" "$DATA" "$LOG"
rsync -a --delete --exclude .git --exclude node_modules "$SRC/" "$PREFIX/"
chown -R vs-core:vs-core "$DATA" "$LOG"
chown -R vs-core:vs-core "$PREFIX"

install -m 0644 "$PREFIX/deploy/vs-core/systemd/vs-core.service" /etc/systemd/system/vs-core.service
install -m 0644 "$PREFIX/deploy/vs-core/systemd/vs-watchdog.service" /etc/systemd/system/vs-watchdog.service
install -m 0644 "$PREFIX/deploy/vs-core/systemd/vs-watchdog.timer" /etc/systemd/system/vs-watchdog.timer
chmod +x "$PREFIX/deploy/vs-core/boot.sh"

# Minimal firewall hint — do not expose Postgres/Redis publicly
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH || true
  # Control API localhost-only by default (CONTROL_API_HOST=127.0.0.1)
fi

systemctl daemon-reload
systemctl enable vs-core.service vs-watchdog.timer
systemctl restart vs-core.service
systemctl start vs-watchdog.timer

echo "VS CORE installed at $PREFIX"
echo "Check: journalctl -u vs-core -f"
