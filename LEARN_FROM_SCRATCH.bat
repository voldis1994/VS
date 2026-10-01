@echo off
setlocal EnableExtensions EnableDelayedExpansion
title VS LEARN FROM SCRATCH — factory reset
color 0E
cd /d "%~dp0"
set "ROOT=%CD%"

echo.
echo ============================================================
echo   VS  LEARN FROM SCRATCH
echo   Genome + learners + vesture -^> FACTORY DEFAULT
echo ============================================================
echo   Mape: %ROOT%
echo.
echo   KEEP  : Capital API, klienti, broker konti, capital_markets, lot
echo   WIPE  : genome, Soft/Peak/Target, auto-cal, learners, experience
echo           trades / positions / executions / audit (DB)
echo.
echo   PIRMS TAM: apturi robotus / FLAT (atverti deali blokē, ja nav --force-open)
echo   Pec tam:  restart VS.bat un startē robotus no jauna
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
if /I "%~1"=="--keep-db-history" set "EXTRA=--keep-db-history"
if /I "%~2"=="--force-open" set "EXTRA=!EXTRA! --force-open"
if /I "%~2"=="--keep-db-history" set "EXTRA=!EXTRA! --keep-db-history"

cd /d "%ROOT%\apps\control-api"
if not exist "node_modules\tsx" (
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
echo [..] Factory reset...
call npx --yes tsx scripts/factoryResetLearning.ts --yes !EXTRA!
set "EC=%ERRORLEVEL%"
echo.
if not "%EC%"=="0" (
  color 0C
  echo [KLUDA] factory reset code=%EC%
  echo         Ja open trade: aizver deali, vai palaid:
  echo         LEARN_FROM_SCRATCH.bat --force-open
  pause
  exit /b %EC%
)

color 0A
echo [OK] LEARN FROM SCRATCH pabeigts.
echo     Capital + klienti paliek. Soft/Peak/Target = factory.
echo     Tagad: VS.bat ^(restart^) un startē robotus.
echo.
pause
exit /b 0
