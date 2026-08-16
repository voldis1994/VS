#!/usr/bin/env bash
# BUILD_RELEASE — produce dist/VS-SERVER, dist/VS-ADMIN, dist/VS-CLIENT packages
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
VER="$(tr -d '[:space:]' <"$ROOT/VERSION" 2>/dev/null || echo '0.0.0')"
rm -rf "$DIST"
mkdir -p "$DIST/VS-SERVER" "$DIST/VS-ADMIN" "$DIST/VS-CLIENT"

echo "Building release $VER → $DIST"

copy_tree() {
  local src="$1" dest="$2"
  mkdir -p "$dest"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude node_modules --exclude dist --exclude coverage --exclude '*.log' --exclude data \
      "$src/" "$dest/"
  else
    # portable fallback
    (
      cd "$src"
      tar --exclude=node_modules --exclude=dist --exclude=coverage --exclude='*.log' --exclude=data -cf - .
    ) | (cd "$dest" && tar -xf -)
  fi
}

copy_tree "$ROOT/SERVER" "$DIST/VS-SERVER/SERVER"
cp -a "$ROOT/VERSION" "$DIST/VS-SERVER/" 2>/dev/null || true
copy_tree "$ROOT/DOCS" "$DIST/VS-SERVER/DOCS"
cat >"$DIST/VS-SERVER/INSTALL.txt" <<EOF
VS SERVER $VER — Debian 13 (VS-CORE-01)
1. Copy this folder to the i3
2. sudo bash SERVER/install/INSTALL_SERVER.sh
3. Configure Capital + PUBLIC_HOST_OR_IP in server.env as needed
4. sudo bash SERVER/FINAL_ACCEPTANCE.sh
5. sudo bash SERVER/SHOW_DASHBOARD.sh   # or INSTALL_MONITOR
EOF

copy_tree "$ROOT/ADMIN" "$DIST/VS-ADMIN/ADMIN"
if [[ -d "$ROOT/apps/dashboard" ]]; then
  copy_tree "$ROOT/apps/dashboard" "$DIST/VS-ADMIN/apps/dashboard"
fi
cp -a "$ROOT/VERSION" "$DIST/VS-ADMIN/" 2>/dev/null || true
cat >"$DIST/VS-ADMIN/INSTALL.txt" <<EOF
VS ADMIN $VER — Windows 11 MSI
1. Run ADMIN\\INSTALL_ADMIN.bat
2. Run ADMIN\\START_ADMIN.bat
3. Run ADMIN\\FINAL_ACCEPTANCE.bat
LAN target: http://192.168.0.10:3000 (configure if different)
EOF

copy_tree "$ROOT/CLIENT" "$DIST/VS-CLIENT/CLIENT"
cp -a "$ROOT/VERSION" "$DIST/VS-CLIENT/" 2>/dev/null || true
cat >"$DIST/VS-CLIENT/INSTALL.txt" <<EOF
VS CLIENT $VER — remote Windows
1. Obtain enrollment package from ADMIN (one device)
2. Run CLIENT\\INSTALL_CLIENT.bat (or consume enrollment)
3. Run CLIENT\\VERIFY_CLIENT.bat
4. Run CLIENT\\FINAL_ACCEPTANCE.bat
5. Run CLIENT\\START_CLIENT.bat if present
Requires WireGuard + reachable PUBLIC_HOST_OR_IP:51820
EOF

echo "Release files: $(find "$DIST" -type f | wc -l)"
echo "DONE: $DIST"
