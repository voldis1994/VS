@echo off
REM FORCE connect — NO discovery spam. Run from VS repo root ONLY.
REM   cd /d C:\VS-main
REM   git pull origin main
REM   ADMIN\CONNECT_FORCE.bat
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0\.."

echo ############################################
echo # VS CONNECT_FORCE (no LAN scan)
echo # cwd=%CD%
echo ############################################

if not exist "ADMIN\desktop\package.json" (
  echo FAIL: not VS repo. cd /d C:\VS-main first.
  pause
  exit /b 1
)

where git >nul 2>&1 && git pull origin main

set "IP=192.168.0.10"
if exist "ADMIN\config\SERVER_IP.txt" (
  set /p IP=<ADMIN\config\SERVER_IP.txt
)
set "IP=%IP: =%"
set "URL=http://%IP%:3000"

echo.
echo MSI IPv4:
ipconfig | findstr /R /C:"IPv4"
echo.
echo Target: %URL%/health
echo.

echo === PING %IP% ===
ping -n 2 %IP%
echo.

echo === CURL (must show service VS-CORE) ===
where curl.exe >nul 2>&1
if errorlevel 1 (
  echo FAIL: curl.exe missing
  pause
  exit /b 1
)
curl.exe -sS --connect-timeout 5 --max-time 8 "%URL%/health"
if errorlevel 1 (
  echo.
  echo FAIL: MSI cannot reach i3:%IP%:3000
  echo i3 can be healthy while MSI is blocked by WiFi AP isolation.
  echo.
  echo FIX ONE OF:
  echo   1^) Same WiFi SSID as i3 ^(NOT Guest^)
  echo   2^) Router: disable AP / Client Isolation / Guest Isolation
  echo   3^) Ethernet cable MSI to same router as i3
  echo   4^) WireGuard up, then set SERVER_IP.txt to 10.77.0.1
  echo.
  echo Trying WireGuard 10.77.0.1 ...
  curl.exe -sS --connect-timeout 3 --max-time 5 "http://10.77.0.1:3000/health"
  if errorlevel 1 (
    echo WG also down.
    pause
    exit /b 1
  )
  set "IP=10.77.0.1"
  set "URL=http://10.77.0.1:3000"
  echo WG OK — using %URL%
)

echo.
mkdir ADMIN\config 2>nul
echo %IP%> ADMIN\config\SERVER_IP.txt
echo Wrote ADMIN\config\SERVER_IP.txt = %IP%

REM seed control-panel.env so START_ADMIN skips broken discovery if needed
if not exist "ADMIN\config\control-panel.env" (
  echo VS_SERVER_URL=%URL%> ADMIN\config\control-panel.env
  echo VITE_API_URL=%URL%>> ADMIN\config\control-panel.env
  echo VS_LAN_SERVER_URL=%URL%>> ADMIN\config\control-panel.env
  echo VS_ADMIN_TRANSPORT=lan>> ADMIN\config\control-panel.env
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$p='ADMIN\config\control-panel.env'; $u='%URL%'; $c=Get-Content $p -ErrorAction SilentlyContinue; if(-not $c){$c=@()}; $m=@{}; foreach($l in $c){ if($l -match '^([^=]+)=(.*)$'){ $m[$matches[1]]=$matches[2] } }; $m['VS_SERVER_URL']=$u; $m['VITE_API_URL']=$u; $m['VS_LAN_SERVER_URL']=$u; $m['VS_ADMIN_TRANSPORT']='lan'; $m.GetEnumerator() | ForEach-Object { $_.Key+'='+$_.Value } | Set-Content $p -Encoding ascii"
)

echo.
echo Starting ADMIN against %URL% ...
call ADMIN\START_ADMIN.bat
exit /b %ERRORLEVEL%
