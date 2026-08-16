#!/usr/bin/env bash
# Build customer CLIENT package (portable folder; .exe packaging is operator/CI step).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/VS-CLIENT"
rm -rf "$OUT"
mkdir -p "$OUT/CLIENT/desktop" "$OUT/CLIENT/windows" "$OUT/CLIENT/connection"
cp -a "$ROOT/CLIENT/desktop/." "$OUT/CLIENT/desktop/"
cp -a "$ROOT/CLIENT/windows/." "$OUT/CLIENT/windows/"
cp -a "$ROOT/CLIENT/connection/." "$OUT/CLIENT/connection/" 2>/dev/null || true
cp -a "$ROOT/CLIENT/VERIFY_CLIENT.bat" "$OUT/CLIENT/" 2>/dev/null || true
cp -a "$ROOT/CLIENT/FINAL_ACCEPTANCE.bat" "$OUT/CLIENT/" 2>/dev/null || true
cp -a "$ROOT/CLIENT/INSTALL_CLIENT.bat" "$OUT/CLIENT/" 2>/dev/null || true
cp -a "$ROOT/CLIENT/START_CLIENT.bat" "$OUT/CLIENT/" 2>/dev/null || true
cat >"$OUT/INSTALL.txt" <<EOF
VS CLIENT
1. Place enrollment package under CLIENT/enrollment/
2. Run CLIENT\\windows\\INSTALL_CLIENT.bat as Administrator
3. WireGuard peer is imported from enrollment (no manual key editing)
4. Run CLIENT\\START_CLIENT.bat — launches prebuilt desktop UI
5. VERIFY_CLIENT.bat must print CLIENT READY

Customer must NOT need Git, Node, or Bash for a packaged release.
Repository builds: npm run build in CLIENT/desktop; CI wraps as VS_CLIENT_SETUP.exe.
EOF
if command -v npm >/dev/null; then
  (cd "$ROOT/CLIENT/desktop" && npm install --no-fund --no-audit && npm run build) || true
  if [[ -d "$ROOT/CLIENT/desktop/dist" ]]; then
    mkdir -p "$OUT/CLIENT/desktop/dist"
    cp -a "$ROOT/CLIENT/desktop/dist/." "$OUT/CLIENT/desktop/dist/"
  fi
fi
# Marker for Inno/NSIS packagers
cat >"$OUT/CLIENT/BUILD_META.txt" <<EOF
product=VS_CLIENT
installer_target=VS_CLIENT_SETUP.exe
desktop=CLIENT/desktop
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
echo "Customer package: $OUT"
echo "NOTE: VS_CLIENT_SETUP.exe requires Windows packager (Inno Setup / electron-builder)."
