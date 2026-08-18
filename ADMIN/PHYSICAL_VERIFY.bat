@echo off
REM Canonical MSI physical verification — run from VS repo root ONLY.
REM   cd /d C:\VS-main
REM   git pull origin main
REM   echo REAL_I3_IP> ADMIN\config\SERVER_IP.txt
REM   ADMIN\PHYSICAL_VERIFY.bat
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0\.."

echo ############################################
echo # VS PHYSICAL VERIFICATION (MSI -^> i3)
echo # cwd=%CD%
echo ############################################

if not exist "ADMIN\desktop\main.py" (
  echo FAIL: not VS repo. Use C:\VS-main not C:\VS-admin
  pause
  exit /b 1
)

set "IP=192.168.0.10"
if exist "ADMIN\config\SERVER_IP.txt" (
  set /p IP=<ADMIN\config\SERVER_IP.txt
)
set "IP=%IP: =%"
set "URL=http://%IP%:3000"
set "EXPECTED=VS-CORE-01"
set "FAIL=0"

echo.
echo App: VS ADMIN physical chain check
echo Target: %URL%
echo Expected identity: %EXPECTED%
echo.

echo === [1] MSI IPv4 (must share subnet with i3) ===
set "MSI_PREFIX="
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4"') do (
  set "LINE=%%A"
  set "LINE=!LINE: =!"
  echo   !LINE!
  for /f "tokens=1-3 delims=." %%B in ("!LINE!") do set "MSI_PREFIX=%%B.%%C.%%D"
)
for /f "tokens=1-3 delims=." %%A in ("%IP%") do set "I3_PREFIX=%%A.%%B.%%C"
if defined MSI_PREFIX if not "!MSI_PREFIX!"=="!I3_PREFIX!" (
  echo.
  echo WARN: MSI subnet !MSI_PREFIX!.x differs from i3 target !I3_PREFIX!.x
  echo       You are likely pointing at the WRONG host ^(e.g. 192.168.8.10 vs i3 192.168.0.10^).
  echo       On i3 run: hostname -I
  echo       Then: echo REAL_IP^> ADMIN\config\SERVER_IP.txt
  set "FAIL=1"
)
echo.

echo === [2] ping %IP% ===
ping -n 2 %IP%
if errorlevel 1 (
  echo FAIL: ping — same WiFi SSID as i3? AP isolation off?
  set "FAIL=1"
)
echo.

echo === [3] /health identity (service=VS-CORE + server_id) ===
where curl.exe >nul 2>&1
if errorlevel 1 (
  echo FAIL: curl.exe missing
  pause
  exit /b 1
)
curl.exe -sS --connect-timeout 5 --max-time 8 "%URL%/health"
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Assert-VsCoreHealth.ps1" -Url "%URL%" -ExpectedId "%EXPECTED%"
if errorlevel 1 (
  echo FAIL: /health identity — not VS-CORE-01 at %URL%
  echo       Random :3000 on your subnet returns 200 but is NOT i3.
  set "FAIL=1"
) else (
  echo PASS: server identity
)
echo.

echo === [4] LAN bootstrap token ===
curl.exe -sS --connect-timeout 5 --max-time 8 "%URL%/api/v1/admin/lan-bootstrap" -o "%TEMP%\vs-lan-boot.json"
if exist "%TEMP%\vs-lan-boot.json" (
  type "%TEMP%\vs-lan-boot.json"
  echo.
  findstr /C:"api_admin_token" "%TEMP%\vs-lan-boot.json" >nul && (
    echo PASS: lan-bootstrap token present
  ) || (
    echo WARN: lan-bootstrap missing token — on i3: VS_LAN_TRUST_ADMIN=1 + sudo bash FORCE_I3_LAN
    set "FAIL=1"
  )
) else (
  echo FAIL: no lan-bootstrap response
  set "FAIL=1"
)
echo.

echo === [5] Server ready ^(supervisor^) ===
set "TOKEN="
if exist "ADMIN\config\control-panel.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("ADMIN\config\control-panel.env") do (
    if /I "%%A"=="API_ADMIN_TOKEN" set "TOKEN=%%B"
    if /I "%%A"=="VITE_API_ADMIN_TOKEN" if not defined TOKEN set "TOKEN=%%B"
  )
)
if not defined TOKEN (
  echo SKIP: no API_ADMIN_TOKEN — START_MSI.bat writes it via lan-bootstrap
) else (
  curl.exe -sS --connect-timeout 5 --max-time 8 -H "x-admin-token: %TOKEN%" "%URL%/api/v1/system/supervisor" -o "%TEMP%\vs-supervisor.json"
  if exist "%TEMP%\vs-supervisor.json" (
    findstr /C:"process_ready" "%TEMP%\vs-supervisor.json" | findstr /C:"true" >nul && (
      echo PASS: process_ready=true
    ) || (
      echo WARN: process_ready not true — i3 may still be booting MI/DB
      type "%TEMP%\vs-supervisor.json"
    )
  )
)
echo.

echo === [6] Heartbeat (MSI -^> i3 presence) ===
if not defined TOKEN (
  echo SKIP: no token for heartbeat
) else (
  curl.exe -sS -X POST --connect-timeout 5 --max-time 8 ^
    -H "Content-Type: application/json" ^
    -H "x-admin-token: %TOKEN%" ^
    -d "{\"device_id\":\"VS-ADMIN-01\",\"display_name\":\"VS-ADMIN-01\",\"role\":\"ADMIN\",\"transport\":\"LAN\"}" ^
    "%URL%/api/v1/presence/heartbeat" -o "%TEMP%\vs-hb.json"
  if exist "%TEMP%\vs-hb.json" (
    type "%TEMP%\vs-hb.json"
    echo.
    findstr /C:"ok" "%TEMP%\vs-hb.json" >nul && echo PASS: heartbeat accepted || (
      echo WARN: heartbeat not confirmed
      set "FAIL=1"
    )
  )
)
echo.

if "%FAIL%"=="1" (
  echo ############################################
  echo # PHYSICAL VERIFICATION FAILED
  echo ############################################
  echo Fix checklist:
  echo   1. i3: sudo bash FORCE_I3_LAN  ^& curl LAN_IP/health
  echo   2. MSI: echo i3_LAN_IP^> ADMIN\config\SERVER_IP.txt
  echo   3. MSI: START_MSI.bat  (VS Admin.exe — not a browser)
  pause
  exit /b 1
)

echo ############################################
echo # PHYSICAL VERIFICATION PASSED (software)
echo # Open UI: START_MSI.bat  — VS Admin.exe must show CONNECTED
echo ############################################
pause
exit /b 0
