#!/usr/bin/env bash
# INSTALL_PANEL_V2 — optional autostart for graphical VS CORE panel
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
mkdir -p "$DESKTOP"
cat >"$DESKTOP/vs-core-panel-v2.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=VS CORE Panel
Exec=bash $HERE/SHOW_PANEL.sh
X-GNOME-Autostart-enabled=true
EOF
chmod +x "$HERE/SHOW_PANEL.sh"
echo "Installed autostart: $DESKTOP/vs-core-panel-v2.desktop"
echo "Backend remains systemd vs-server — panel is monitor only."
