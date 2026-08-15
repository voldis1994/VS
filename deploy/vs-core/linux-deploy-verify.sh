#!/usr/bin/env bash
# VS CORE Linux deployment verification (CI/container/VM — not physical i3).
# Exit 0 = PASS, 2 = EXTERNAL_BLOCKER physical only items skipped, 1 = FAIL
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
pass() { echo "PASS  $1 — $2"; }
fail() { echo "FAIL  $1 — $2"; FAIL=1; }

echo "=== VS CORE LINUX DEPLOYMENT VERIFY ==="
echo "ROOT=$ROOT"

# Service unit files exist
for f in vs-core.service vs-watchdog.service vs-watchdog.timer; do
  if [[ -f "$ROOT/deploy/vs-core/systemd/$f" ]]; then
    pass "UNIT_$f" "present"
  else
    fail "UNIT_$f" "missing"
  fi
done

# Boot / install scripts executable
for s in boot.sh install.sh; do
  if [[ -x "$ROOT/deploy/vs-core/$s" ]]; then
    pass "SCRIPT_$s" "executable"
  elif [[ -f "$ROOT/deploy/vs-core/$s" ]]; then
    fail "SCRIPT_$s" "not executable"
  else
    fail "SCRIPT_$s" "missing"
  fi
done

# Dependency ordering mentioned in unit
if grep -q 'After=network-online.target' "$ROOT/deploy/vs-core/systemd/vs-core.service"; then
  pass "DEPENDENCY_ORDER" "After=network-online.target"
else
  fail "DEPENDENCY_ORDER" "missing network-online After="
fi

# Restart policy
if grep -q 'Restart=on-failure' "$ROOT/deploy/vs-core/systemd/vs-core.service"; then
  pass "RESTART_POLICY" "Restart=on-failure"
else
  fail "RESTART_POLICY" "missing"
fi

# Non-root user
if grep -q 'User=vs-core' "$ROOT/deploy/vs-core/systemd/vs-core.service"; then
  pass "PERMISSIONS_USER" "User=vs-core"
else
  fail "PERMISSIONS_USER" "missing User=vs-core"
fi

# Paths
if grep -q 'VS_CORE_DATA=/var/lib/vs-core' "$ROOT/deploy/vs-core/systemd/vs-core.service"; then
  pass "PATHS_DATA" "VS_CORE_DATA set"
else
  fail "PATHS_DATA" "missing"
fi

# LIVE money disabled by default
if grep -q 'LIVE_TRADING_ENABLED=false' "$ROOT/deploy/vs-core/systemd/vs-core.service"; then
  pass "ENV_LIVE_OFF" "LIVE_TRADING_ENABLED=false"
else
  fail "ENV_LIVE_OFF" "LIVE not disabled by default"
fi

# Resource limits
if grep -q 'MemoryMax=' "$ROOT/deploy/vs-core/systemd/vs-core.service"; then
  pass "RESOURCE_LIMITS" "MemoryMax present"
else
  fail "RESOURCE_LIMITS" "missing MemoryMax"
fi

# Watchdog timer
if grep -q 'OnUnitActiveSec=' "$ROOT/deploy/vs-core/systemd/vs-watchdog.timer"; then
  pass "WATCHDOG_TIMER" "periodic"
else
  fail "WATCHDOG_TIMER" "missing"
fi

# Physical appliance package present
if [[ -x "$ROOT/deploy/vs-core/appliance-verify.sh" ]]; then
  pass "APPLIANCE_PACKAGE" "appliance-verify.sh ready"
else
  fail "APPLIANCE_PACKAGE" "missing appliance-verify.sh"
fi

echo "EXTERNAL_BLOCKER  PHYSICAL_i3 — not run here (use appliance-verify.sh on hardware)"

if [[ "$FAIL" -ne 0 ]]; then
  echo "RESULT FAIL"
  exit 1
fi
echo "RESULT PASS"
exit 0
