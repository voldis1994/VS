@echo off
REM INSTALL_CLIENT.bat — WireGuard + CLIENT app enrollment consumer
setlocal EnableExtensions
cd /d "%~dp0.."
echo VS CLIENT INSTALL
echo =================
where wg >nul 2>&1
if errorlevel 1 (
  echo [FAIL] WireGuard not on PATH. Install WireGuard for Windows first.
  echo CLIENT NOT READY
  exit /b 1
)
if not exist "%~dp0..\enrollment" if not exist "%USERPROFILE%\.vs-client\enrollment" (
  echo [CONFIG_REQUIRED] No enrollment package found.
  echo Create enrollment from ADMIN Network page and place under CLIENT\enrollment\
  echo CLIENT NOT READY
  exit /b 2
)
echo [PASS] prerequisites present
echo Next: import WireGuard peer from enrollment, then run VERIFY_CLIENT.bat
echo Then START_CLIENT.bat
exit /b 0
