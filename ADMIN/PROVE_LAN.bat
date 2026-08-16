@echo off
REM Prove MSI can reach i3 Control API — run from VS repo root.
REM   cd /d C:\VS-main
REM   ADMIN\PROVE_LAN.bat
setlocal EnableExtensions
cd /d "%~dp0\.."

set "IP=192.168.0.10"
if exist "ADMIN\config\SERVER_IP.txt" (
  set /p IP=<ADMIN\config\SERVER_IP.txt
)
set "IP=%IP: =%"

echo ========================================
echo  VS PROVE_LAN — MSI -^> i3
echo  Target IP = %IP%
echo ========================================
echo.
echo [1] MSI IPv4 addresses:
ipconfig | findstr /R /C:"IPv4"
echo.
echo [2] ping %IP%  (if FAIL = different WiFi or AP isolation)
ping -n 2 %IP%
echo.
echo [3] curl.exe http://%IP%:3000/health
where curl.exe >nul 2>&1
if errorlevel 1 (
  echo FAIL: curl.exe missing
  pause
  exit /b 1
)
curl.exe -v --connect-timeout 5 --max-time 8 "http://%IP%:3000/health"
echo.
echo [4] WireGuard fallback probe 10.77.0.1
curl.exe -sS --connect-timeout 3 --max-time 5 "http://10.77.0.1:3000/health" && echo WG OK || echo WG not up yet
echo.
echo If [3] fails but i3 curl to same IP works:
echo   - MSI and i3 must be on SAME WiFi SSID (not Guest)
echo   - Router: disable AP / client isolation
echo   - Or connect MSI with ethernet to same router
echo   - Or finish WireGuard then use 10.77.0.1
echo.
pause
exit /b 0
