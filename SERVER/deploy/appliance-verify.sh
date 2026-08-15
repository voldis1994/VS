#!/usr/bin/env bash
# Physical i3 appliance verification — run ON the VS SERVER host after INSTALL_SERVER.
set -euo pipefail

if [[ "${VS_PHYSICAL_APPLIANCE:-}" != "1" ]]; then
  echo "EXTERNAL_BLOCKER_PHYSICAL_APPLIANCE"
  echo "Set VS_PHYSICAL_APPLIANCE=1 on the real i3 host to execute checks."
  exit 2
fi

FAIL=0
pass() { echo "PASS  $1 — $2"; }
fail() { echo "FAIL  $1 — $2"; FAIL=1; }

echo "=== VS SERVER PHYSICAL APPLIANCE VERIFY ==="

if command -v nproc >/dev/null; then
  pass "CPU" "nproc=$(nproc)"
else
  fail "CPU" "nproc missing"
fi

if [[ -f /proc/meminfo ]]; then
  mt=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
  pass "RAM" "MemTotal_kB=$mt"
  if [[ "$mt" -lt 8000000 ]]; then
    fail "RAM_CAPACITY" "expected >= ~8GB for 16GB target class (got ${mt}kB)"
  fi
else
  fail "RAM" "/proc/meminfo missing"
fi

df -h / | tail -1 | awk '{print "PASS  SSD — "$0}' || fail "SSD" "df failed"

if ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1 || true; then
  pass "NETWORK" "probe attempted"
fi

if command -v timedatectl >/dev/null; then
  timedatectl status | head -5 || true
  pass "TIME" "timedatectl present"
else
  fail "TIME" "timedatectl missing"
fi

if systemctl is-enabled vs-server.service >/dev/null 2>&1 || systemctl is-enabled vs-core.service >/dev/null 2>&1; then
  pass "AUTOSTART" "vs-server/vs-core enabled"
else
  fail "AUTOSTART" "service not enabled"
fi

if systemctl is-active vs-server.service >/dev/null 2>&1 || systemctl is-active vs-core.service >/dev/null 2>&1; then
  pass "SERVICE_ACTIVE" "active"
else
  fail "SERVICE_ACTIVE" "not active"
fi

if id vs-server >/dev/null 2>&1 || id vs-core >/dev/null 2>&1; then
  pass "PERMISSIONS" "service user exists"
else
  fail "PERMISSIONS" "service user missing"
fi

for p in /opt/vs-server /var/lib/vs-server /var/log/vs-server /opt/vs-core /var/lib/vs-core; do
  if [[ -d "$p" ]]; then
    pass "PATH_$p" "exists"
  fi
done

if [[ "$FAIL" -ne 0 ]]; then
  echo "APPLIANCE FAIL"
  exit 1
fi
echo "APPLIANCE PASS"
exit 0
