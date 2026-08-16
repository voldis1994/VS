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

if "%VS_SERVER_URL%"=="" set "VS_SERVER_URL=http://10.77.0.1:3000"

echo.
echo Checking WireGuard path %VS_SERVER_URL%/health ...
curl.exe -fsS "%VS_SERVER_URL%/health"
if errorlevel 1 (
  echo.
  echo FAIL: nevar sasniegt SERVER.
  echo  - WireGuard Activate?
  echo  - Endpoint = i3 LAN IP:51820  ne VS-CORE-01?
  echo  - ping 10.77.0.1
  pause
  exit /b 1
)

echo.
echo Starting VS ADMIN...
set "API_ADMIN_TOKEN=%API_ADMIN_TOKEN%"
set "VS_SERVER_URL=%VS_SERVER_URL%"
npx --yes tsx app/startAdmin.ts
pause
