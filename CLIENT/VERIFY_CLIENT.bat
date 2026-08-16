@echo off
REM VERIFY_CLIENT.bat — WireGuard + CLIENT API reachability checklist
setlocal EnableExtensions
cd /d "%~dp0"

echo VS CLIENT VERIFY
echo ================

where wg >nul 2>&1
if errorlevel 1 (
  echo [FAIL] WireGuard tools not on PATH
  echo CLIENT NOT READY
  exit /b 1
)

wg show >nul 2>&1
if errorlevel 1 (
  echo [CONFIG_REQUIRED] WireGuard tunnel not active — import enrollment package
  echo CLIENT NOT READY
  exit /b 2
)

echo [PASS] WireGuard tools present
ping -n 1 -w 2000 10.77.0.1 >nul 2>&1
if errorlevel 1 (
  echo [FAIL] 10.77.0.1 not reachable
  echo CLIENT NOT READY
  exit /b 1
)
echo [PASS] VPN gateway 10.77.0.1 reachable

curl -fsS --max-time 5 http://10.77.0.1:3000/health >nul 2>&1
if errorlevel 1 (
  echo [FAIL] CLIENT API /health via VPN
  echo CLIENT NOT READY
  exit /b 1
)
echo [PASS] CLIENT API health via VPN
echo CLIENT READY
exit /b 0
