@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0.."
set "ROOT=%CD%"
title VS SYSTEM - FULL RESTART

color 0B
cls
echo ============================================================
echo   VS SYSTEM - FULL RESTART
echo   1^) Stop everything
echo   2^) Pull latest main from GitHub
echo   3^) Start stack for Client Panel + robots
echo ============================================================
echo   Folder: %ROOT%
echo.

if not exist "%ROOT%\apps\market-core\CMakeLists.txt" (
  color 0C
  echo [FAIL] Not a VS / Market Reader repo folder.
  echo        Put VS_RESTART.exe inside the cloned VS folder.
  pause
  exit /b 1
)

REM ---------- load .env into this process ----------
if exist "%ROOT%\.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT%\.env") do (
    if not "%%A"=="" (
      set "line=%%A"
      if not "!line:~0,1!"=="#" set "%%A=%%B"
    )
  )
)

echo [1/6] Stopping running VS services...
call "%ROOT%\scripts\stop_all_vs.bat"
ping -n 2 127.0.0.1 >nul
echo [OK] stop done
echo.

echo [2/6] Updating from GitHub main...
where git >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [FAIL] Git not installed.
  pause
  exit /b 1
)
cd /d "%ROOT%"
git fetch origin main
if errorlevel 1 (
  color 0C
  echo [FAIL] git fetch failed. Check internet / login.
  pause
  exit /b 1
)
git checkout main
git pull origin main
if errorlevel 1 (
  color 0C
  echo [FAIL] git pull failed. Commit/stash local changes or fix conflicts.
  pause
  exit /b 1
)
echo [OK] main is up to date
for /f "delims=" %%H in ('git rev-parse --short HEAD') do echo       commit %%H
echo.

echo [3/6] Docker Postgres + Redis...
docker info >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [FAIL] Docker Desktop is not running. Start Docker, then re-run.
  pause
  exit /b 1
)
docker start market-reader-postgres >nul 2>&1
docker start market-reader-redis >nul 2>&1
docker compose up -d postgres redis
if errorlevel 1 (
  echo [WARN] docker compose had issues — retrying once...
  docker compose up -d postgres redis
)
ping -n 4 127.0.0.1 >nul
echo [OK] database containers
echo.

echo [4/6] npm install + DB migrate...
cd /d "%ROOT%\apps\control-api"
call npm install
if errorlevel 1 (
  color 0C
  echo [FAIL] control-api npm install failed
  pause
  exit /b 1
)
call npm run migrate
if errorlevel 1 (
  color 0C
  echo [FAIL] migrations failed. Check .env DB_* settings.
  pause
  exit /b 1
)
cd /d "%ROOT%\apps\dashboard"
call npm install
if errorlevel 1 (
  color 0C
  echo [FAIL] dashboard npm install failed
  pause
  exit /b 1
)
cd /d "%ROOT%"
echo [OK] API + dashboard ready
echo.

echo [5/6] Starting services...

set "MC=%ROOT%\build\windows-debug\apps\market-core\market-core.exe"
if not exist "%MC%" set "MC=%ROOT%\build\windows-release\apps\market-core\market-core.exe"
if exist "%MC%" (
  REM Client Panel production path: LIVE bridge → pipeline intents
  start "MR-MarketCore" /D "%ROOT%" cmd /k set MARKET_CORE_BRIDGE=1^& set OPERATING_MODE=LIVE^& "%MC%" --mode LIVE --bridge
  echo [OK] market-core LIVE --bridge
) else (
  echo [WARN] market-core.exe not found — run START_HERE.bat once to build.
)

ping -n 2 127.0.0.1 >nul

set "EX=%ROOT%\build\windows-debug\apps\execution-service\execution-service.exe"
if not exist "%EX%" set "EX=%ROOT%\build\windows-release\apps\execution-service\execution-service.exe"
if exist "%EX%" (
  start "MR-Execution" /D "%ROOT%" cmd /k "%EX%" --mode LIVE
)

start "MR-ControlAPI" /D "%ROOT%\apps\control-api" cmd /k npm run dev
ping -n 5 127.0.0.1 >nul

start "MR-Dashboard" /D "%ROOT%\apps\dashboard" cmd /k npm run dev
ping -n 3 127.0.0.1 >nul

start "MR-ClientPanel" /D "%ROOT%\apps\dashboard" cmd /k npm run dev:client
ping -n 3 127.0.0.1 >nul

echo [OK] Control API + Admin desk + Client panel started
echo.

echo [6/6] Public tunnel for REMOTE clients...
start "MR-ClientTunnel" /D "%ROOT%" cmd /k call "%ROOT%\scripts\share_client_panel.bat"
echo.
echo ============================================================
echo   VS SYSTEM RESTARTED
echo.
echo   ADMIN ^(you^):     http://localhost:5173/
echo   CLIENT panel:     http://localhost:5174/
echo.
echo   REMOTE CLIENT LINK:
echo     Look in the window titled  MR-ClientTunnel
echo     Copy the https://....trycloudflare.com URL
echo     Send that URL + access code to the client.
echo.
echo   Client steps:
echo     1^) Open the https tunnel link
echo     2^) Login with access code
echo     3^) Choose market + lot
echo     4^) Tap START
echo ============================================================
echo.
start http://localhost:5173/clients
ping -n 2 127.0.0.1 >nul
start http://localhost:5174/
echo.
echo Press any key to close this launcher ^(services keep running^).
pause >nul
exit /b 0
