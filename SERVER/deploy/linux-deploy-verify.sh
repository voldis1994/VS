#!/usr/bin/env bash
# VS SERVER Linux deployment verification (CI/container/VM — not physical i3).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY="$ROOT/SERVER/deploy"
FAIL=0
pass() { echo "PASS  $1 — $2"; }
fail() { echo "FAIL  $1 — $2"; FAIL=1; }

echo "=== VS SERVER LINUX DEPLOYMENT VERIFY ==="
echo "ROOT=$ROOT DEPLOY=$DEPLOY"

for f in vs-core.service vs-watchdog.service vs-watchdog.timer; do
  if [[ -f "$DEPLOY/systemd/$f" ]]; then
    pass "UNIT_$f" "present"
  else
    fail "UNIT_$f" "missing"
  fi
done

for s in boot.sh install.sh; do
  if [[ -x "$DEPLOY/$s" ]]; then
    pass "SCRIPT_$s" "executable"
  elif [[ -f "$DEPLOY/$s" ]]; then
    fail "SCRIPT_$s" "not executable"
  else
    fail "SCRIPT_$s" "missing"
  fi
done

# Product entrypoints
for e in INSTALL_SERVER START_SERVER STOP_SERVER STATUS_SERVER; do
  if [[ -x "$ROOT/SERVER/$e" ]]; then
    pass "ENTRY_$e" "executable"
  elif [[ -f "$ROOT/SERVER/$e" ]]; then
    fail "ENTRY_$e" "not executable"
  else
    fail "ENTRY_$e" "missing"
  fi
done

if grep -q 'After=network-online.target' "$DEPLOY/systemd/vs-core.service"; then
  pass "DEPENDENCY_ORDER" "After=network-online.target"
else
  fail "DEPENDENCY_ORDER" "missing network-online After="
fi

if grep -q 'Restart=on-failure' "$DEPLOY/systemd/vs-core.service"; then
  pass "RESTART_POLICY" "Restart=on-failure"
else
  fail "RESTART_POLICY" "missing"
fi

if grep -Eq 'User=vs-(server|core)' "$DEPLOY/systemd/vs-core.service"; then
  pass "PERMISSIONS_USER" "non-root service user"
else
  fail "PERMISSIONS_USER" "missing User="
fi

if grep -Eq 'VS_(SERVER|CORE)_DATA=' "$DEPLOY/systemd/vs-core.service"; then
  pass "PATHS_DATA" "DATA path set"
else
  fail "PATHS_DATA" "missing"
fi

if grep -q 'LIVE_TRADING_ENABLED=false' "$DEPLOY/systemd/vs-core.service"; then
  pass "ENV_LIVE_OFF" "LIVE_TRADING_ENABLED=false"
else
  fail "ENV_LIVE_OFF" "LIVE not disabled by default"
fi

if grep -q 'MemoryMax=' "$DEPLOY/systemd/vs-core.service"; then
  pass "RESOURCE_LIMITS" "MemoryMax present"
else
  fail "RESOURCE_LIMITS" "missing MemoryMax"
fi

if grep -q 'OnUnitActiveSec=' "$DEPLOY/systemd/vs-watchdog.timer"; then
  pass "WATCHDOG_TIMER" "periodic"
else
  fail "WATCHDOG_TIMER" "missing"
fi

if [[ -x "$DEPLOY/appliance-verify.sh" ]]; then
  pass "APPLIANCE_PACKAGE" "appliance-verify.sh ready"
else
  fail "APPLIANCE_PACKAGE" "missing appliance-verify.sh"
fi

if [[ -d "$ROOT/SERVER/control-api/src/vs-core" ]]; then
  pass "SERVER_CORE" "control-api migrated under SERVER/"
else
  fail "SERVER_CORE" "SERVER/control-api/src/vs-core missing"
fi

echo "EXTERNAL_BLOCKER  PHYSICAL_i3 — not run here (use appliance-verify.sh on hardware)"

if [[ "$FAIL" -ne 0 ]]; then
  echo "RESULT FAIL"
  exit 1
fi
echo "RESULT PASS"
exit 0
