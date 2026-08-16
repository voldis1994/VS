#!/usr/bin/env bash
# Build customer CLIENT package (portable folder; .exe packaging is operator/CI step).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/dist/VS-CLIENT"
rm -rf "$OUT"
mkdir -p "$OUT/CLIENT/apps/client-v2" "$OUT/CLIENT/windows" "$OUT/CLIENT/wireguard"
cp -a "$ROOT/CLIENT/apps/client-v2/." "$OUT/CLIENT/apps/client-v2/"
cp -a "$ROOT/CLIENT/windows/." "$OUT/CLIENT/windows/"
cp -a "$ROOT/CLIENT/VERIFY_CLIENT.bat" "$OUT/CLIENT/" 2>/dev/null || true
cp -a "$ROOT/CLIENT/FINAL_ACCEPTANCE.bat" "$OUT/CLIENT/" 2>/dev/null || true
cp -a "$ROOT/CLIENT/INSTALL_CLIENT.bat" "$OUT/CLIENT/" 2>/dev/null || true
cat >"$OUT/INSTALL.txt" <<EOF
VS CLIENT v2
1. Place enrollment package under CLIENT/enrollment/
2. Run CLIENT\\windows\\INSTALL_CLIENT.bat
3. Install WireGuard peer from enrollment
4. cd CLIENT\\apps\\client-v2 && npm install && npm run build && npm run preview
   (packaged release should ship prebuilt dist/ — customer must not need GitHub)
5. VERIFY_CLIENT.bat must print CLIENT READY
EOF
# Prefer prebuild
if command -v npm >/dev/null; then
  (cd "$ROOT/CLIENT/apps/client-v2" && npm install --no-fund --no-audit && npm run build) || true
  if [[ -d "$ROOT/CLIENT/apps/client-v2/dist" ]]; then
    mkdir -p "$OUT/CLIENT/apps/client-v2/dist"
    cp -a "$ROOT/CLIENT/apps/client-v2/dist/." "$OUT/CLIENT/apps/client-v2/dist/"
  fi
fi
echo "Customer package: $OUT"
echo "NOTE: VS-CLIENT-Setup.exe requires Windows CI packager (electron-builder/innosetup) — folder package is repository-controlled."
