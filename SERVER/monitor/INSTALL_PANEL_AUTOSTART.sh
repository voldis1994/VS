#!/usr/bin/env bash
# Optional autostart for graphical VS Server Monitor
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
mkdir -p "$DESKTOP"
cat >"$DESKTOP/vs-server-monitor.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=VS Server Monitor
Exec=python3 $HERE/main.py
X-GNOME-Autostart-enabled=true
EOF
chmod +x "$HERE/SHOW_PANEL.sh" "$HERE/main.py"
echo "Installed autostart: $DESKTOP/vs-server-monitor.desktop"
echo "Backend remains systemd vs-server — this is monitor only."
