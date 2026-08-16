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

REM Fetch admin token from i3 LAN bootstrap (VS_LAN_TRUST_ADMIN=1)
echo === LAN bootstrap token ===
curl.exe -sS --connect-timeout 5 --max-time 8 "%URL%/api/v1/admin/lan-bootstrap" -o "%TEMP%\vs-lan-boot.json"
if exist "%TEMP%\vs-lan-boot.json" (
  type "%TEMP%\vs-lan-boot.json"
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$j=Get-Content $env:TEMP\vs-lan-boot.json -Raw | ConvertFrom-Json; if($j.api_admin_token){ $t=[string]$j.api_admin_token; $p='ADMIN\config\control-panel.env'; if(-not(Test-Path $p)){ New-Item -ItemType File -Path $p -Force | Out-Null }; $c=@(Get-Content $p -ErrorAction SilentlyContinue); $m=@{}; foreach($l in $c){ if($l -match '^([^=]+)=(.*)$'){ $m[$matches[1]]=$matches[2] } }; $m['VS_SERVER_URL']='%URL%'; $m['VITE_API_URL']='%URL%'; $m['VS_LAN_SERVER_URL']='%URL%'; $m['VS_ADMIN_TRANSPORT']='lan'; $m['API_ADMIN_TOKEN']=$t; $m['VITE_API_ADMIN_TOKEN']=$t; $m.GetEnumerator() | ForEach-Object { $_.Key+'='+$_.Value } | Set-Content $p -Encoding ascii; Write-Host ('Wrote API_ADMIN_TOKEN len=' + $t.Length) } else { Write-Host 'WARN: lan-bootstrap missing token — enable VS_LAN_TRUST_ADMIN on i3' }"
)

REM seed control-panel.env URL at minimum
if not exist "ADMIN\config\control-panel.env" (
  echo VS_SERVER_URL=%URL%> ADMIN\config\control-panel.env
  echo VITE_API_URL=%URL%>> ADMIN\config\control-panel.env
  echo VS_LAN_SERVER_URL=%URL%>> ADMIN\config\control-panel.env
  echo VS_ADMIN_TRANSPORT=lan>> ADMIN\config\control-panel.env
)

REM Skip rediscovery in START_ADMIN — LAN already proved by curl above
set "VS_ADMIN_FORCE_URL=%URL%"
set "VS_SERVER_URL=%URL%"
set "VITE_API_URL=%URL%"

echo.
echo Starting ADMIN against %URL% (FORCE — no rescan) ...
call ADMIN\START_ADMIN.bat
exit /b %ERRORLEVEL%
