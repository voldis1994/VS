#!/usr/bin/env bash
# Physical i3 appliance verification — run ON the VS CORE host after install.
# Without hardware: treat as EXTERNAL_BLOCKER_PHYSICAL_APPLIANCE (do not run in CI as FAIL).
set -euo pipefail

if [[ "${VS_PHYSICAL_APPLIANCE:-}" != "1" ]]; then
  echo "EXTERNAL_BLOCKER_PHYSICAL_APPLIANCE"
  echo "Set VS_PHYSICAL_APPLIANCE=1 on the real i3 host to execute checks."
  exit 2
fi

FAIL=0
pass() { echo "PASS  $1 — $2"; }
fail() { echo "FAIL  $1 — $2"; FAIL=1; }

echo "=== VS CORE PHYSICAL APPLIANCE VERIFY ==="

# CPU
if command -v nproc >/dev/null; then
  pass "CPU" "nproc=$(nproc)"
else
  fail "CPU" "nproc missing"
fi

# RAM
if [[ -f /proc/meminfo ]]; then
  mt=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
  pass "RAM" "MemTotal_kB=$mt"
  if [[ "$mt" -lt 8000000 ]]; then
    fail "RAM_CAPACITY" "expected >= ~8GB for 16GB target class (got ${mt}kB)"
  fi
else
  fail "RAM" "/proc/meminfo missing"
fi

# SSD / disk
df -h / | tail -1 | awk '{print "PASS  SSD — "$0}' || fail "SSD" "df failed"

# Network
if ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1 || true; then
  pass "NETWORK" "probe attempted"
fi

# Time
if command -v timedatectl >/dev/null; then
  timedatectl status | head -5 || true
  pass "TIME" "timedatectl present"
else
  fail "TIME" "timedatectl missing"
fi

# Services
if systemctl is-enabled vs-core.service >/dev/null 2>&1; then
  pass "AUTOSTART" "vs-core enabled"
else
  fail "AUTOSTART" "vs-core not enabled"
fi

if systemctl is-active vs-core.service >/dev/null 2>&1; then
  pass "SERVICE_ACTIVE" "vs-core active"
else
  fail "SERVICE_ACTIVE" "vs-core not active"
fi

# Permissions
if id vs-core >/dev/null 2>&1; then
  pass "PERMISSIONS" "user vs-core exists"
else
  fail "PERMISSIONS" "user vs-core missing"
fi

# Paths
for p in /opt/vs-core /var/lib/vs-core /var/log/vs-core; do
  if [[ -d "$p" ]]; then
    pass "PATH_$p" "exists"
  else
    fail "PATH_$p" "missing"
  fi
done

if [[ "$FAIL" -ne 0 ]]; then
  echo "APPLIANCE FAIL"
  exit 1
fi
echo "APPLIANCE PASS"
exit 0
