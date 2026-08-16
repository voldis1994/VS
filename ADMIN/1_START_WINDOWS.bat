@echo off
REM =============================================================================
REM 1_START_WINDOWS.bat — compatibility wrapper
REM Prefer: INSTALL_ADMIN.bat once, then START_ADMIN.bat (Control Panel).
REM This file still starts the CLI diagnostic if you need it.
REM =============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo NOTE: Preferred Windows path is INSTALL_ADMIN.bat then START_ADMIN.bat
echo Continuing with CLI diagnostic...
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo FAIL: uzliec Node.js 20 no https://nodejs.org/
  pause
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo WARN: git nav PATH — ja mape jau ir OK, turpinam
)

if not exist "node_modules\" (
  echo Installing ADMIN deps...
  call npm install
  if errorlevel 1 (
    echo FAIL: npm install
    pause
    exit /b 1
  )
)

REM Load token file from USB / Desktop / same folder
set "TOKEN_FILE="
if exist "%~dp0ADMIN_TOKEN.txt" set "TOKEN_FILE=%~dp0ADMIN_TOKEN.txt"
if exist "%~dp0..\ADMIN_TOKEN.txt" set "TOKEN_FILE=%~dp0..\ADMIN_TOKEN.txt"
if exist "D:\ADMIN_TOKEN.txt" set "TOKEN_FILE=D:\ADMIN_TOKEN.txt"
if exist "E:\ADMIN_TOKEN.txt" set "TOKEN_FILE=E:\ADMIN_TOKEN.txt"
if exist "%USERPROFILE%\Desktop\ADMIN_TOKEN.txt" set "TOKEN_FILE=%USERPROFILE%\Desktop\ADMIN_TOKEN.txt"
if exist "%USERPROFILE%\Desktop\VS-USB\ADMIN_TOKEN.txt" set "TOKEN_FILE=%USERPROFILE%\Desktop\VS-USB\ADMIN_TOKEN.txt"

if defined TOKEN_FILE (
  echo Loading %TOKEN_FILE%
  for /f "usebackq tokens=1,* delims==" %%A in ("%TOKEN_FILE%") do (
    if /I "%%A"=="API_ADMIN_TOKEN" set "API_ADMIN_TOKEN=%%B"
    if /I "%%A"=="VS_SERVER_URL" set "VS_SERVER_URL=%%B"
    if /I "%%A"=="VS_ENROLLMENT_CODE" set "VS_ENROLLMENT_CODE=%%B"
  )
)

if "%API_ADMIN_TOKEN%"=="" (
  echo.
  echo Ievadi API_ADMIN_TOKEN no ADMIN_TOKEN.txt / i3 server.env:
  set /p API_ADMIN_TOKEN=API_ADMIN_TOKEN=
)

if "%VS_SERVER_URL%"=="" set "VS_SERVER_URL=http://192.168.0.10:3000"

echo.
echo Checking LAN path %VS_SERVER_URL%/health ...
curl.exe -fsS --max-time 5 "%VS_SERVER_URL%/health"
if errorlevel 1 (
  echo.
  echo FAIL: cannot reach SERVER on LAN.
  echo  - Is i3 running?  STATUS_SERVER
  echo  - Same Wi-Fi as MSI?
  echo  - Prefer INSTALL_ADMIN.bat / START_ADMIN.bat (LAN-first discovery)
  echo  - WireGuard is NOT required for home ADMIN
  pause
  exit /b 1
)

echo.
echo Starting VS ADMIN...
set "API_ADMIN_TOKEN=%API_ADMIN_TOKEN%"
set "VS_SERVER_URL=%VS_SERVER_URL%"
npx --yes tsx app/startAdmin.ts
pause
