@echo off
setlocal EnableExtensions EnableDelayedExpansion
title VS LEARN FROM SCRATCH — factory reset
color 0E
cd /d "%~dp0"
set "ROOT=%CD%"

echo.
echo ============================================================
echo   VS  LEARN FROM SCRATCH
echo   Genome + learners -^> FACTORY DEFAULT  ^(FAILI, bez DB^)
echo ============================================================
echo   Mape: %ROOT%
echo.
echo   KEEP  : Capital API, klienti, broker konti, capital_markets, lot
echo   WIPE  : genome, Soft/Peak/Target, auto-cal, learners, experience
echo   DB    : NETIKAR ^(piedzimusi hang Windows^) — pec VS.bat:
echo           LEARN_FROM_SCRATCH.bat --wipe-db
echo.
echo   Pec tam: restart VS.bat un starte robotus no jauna
echo.

if not exist "%ROOT%\apps\control-api\package.json" (
  color 0C
  echo [KLUDA] Palaid no VS root mapes.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [KLUDA] Node.js nav PATH.
  pause
  exit /b 1
)

echo   Apstiprinajumam ieraksti: LEARN_FROM_SCRATCH
set /p "CONFIRM=> "
if /I not "!CONFIRM!"=="LEARN_FROM_SCRATCH" (
  color 0C
  echo [ATCELTS] Nepareiza fraze.
  pause
  exit /b 2
)

set "EXTRA="
if /I "%~1"=="--force-open" set "EXTRA=--force-open"
if /I "%~1"=="--wipe-db" set "EXTRA=!EXTRA! --wipe-db"
if /I "%~2"=="--force-open" set "EXTRA=!EXTRA! --force-open"
if /I "%~2"=="--wipe-db" set "EXTRA=!EXTRA! --wipe-db"

cd /d "%ROOT%\apps\control-api"
if not exist "node_modules\tsx\package.json" (
  echo [..] npm install control-api...
  call npm install --registry https://registry.npmjs.org/
  if errorlevel 1 (
    color 0C
    echo [KLUDA] npm install
    pause
    exit /b 1
  )
)

echo.
echo [..] Factory reset FILES only ^(local tsx^)...
if exist "node_modules\.bin\tsx.cmd" (
  call "node_modules\.bin\tsx.cmd" scripts\factoryResetLearning.ts --yes !EXTRA!
) else if exist "node_modules\tsx\dist\cli.mjs" (
  call node "node_modules\tsx\dist\cli.mjs" scripts\factoryResetLearning.ts --yes !EXTRA!
) else (
  call npx --yes tsx scripts/factoryResetLearning.ts --yes !EXTRA!
)
set "EC=%ERRORLEVEL%"
echo.
if not "%EC%"=="0" (
  color 0C
  echo [KLUDA] factory reset code=%EC%
  echo         Open deal: LEARN_FROM_SCRATCH.bat --force-open
  pause
  exit /b %EC%
)

color 0A
echo [OK] LEARN FROM SCRATCH pabeigts ^(faili^).
echo     Capital + klienti paliek. Soft/Peak/Target = factory.
echo     Tagad: VS.bat ^(restart^) un starte robotus.
echo     DB vesture: LEARN_FROM_SCRATCH.bat --wipe-db  ^(kad Postgres augsa^)
echo.
pause
exit /b 0
