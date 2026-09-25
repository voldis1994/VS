@echo off
setlocal EnableExtensions EnableDelayedExpansion
title VS BRAIN SELF-IMPROVE — NEAIZVER SO LOGU
color 0B
cd /d "%~dp0"
set "ROOT=%CD%"

echo.
echo ============================================================
echo   VS BRAIN SELF-IMPROVE  (atsevisks CMD process)
echo   trades -^> analize -^> hipoteze -^> patch -^> test/replay
echo   -^> ACCEPT/REJECT -^> pieredze -^> nakamais cikls
echo ============================================================
echo   Mape: %ROOT%
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

mkdir "%ROOT%\data\brain-self-improve" >nul 2>&1
mkdir "%ROOT%\data\brain-self-improve\candidates" >nul 2>&1
mkdir "%ROOT%\data\brain-self-improve\snapshots" >nul 2>&1
mkdir "%ROOT%\data\brain-self-improve\versions" >nul 2>&1

echo [OK] Startēju autonomo smadzeņu ciklu...
echo     Ctrl+C aptur. Rezultati: data\brain-self-improve\
echo.

set "BRAIN_CYCLE_INTERVAL_SEC=180"
call npx --yes tsx src/brainSelfImprove/cli.ts %*
set "EC=%ERRORLEVEL%"
echo.
echo [EXIT] brain self-improve code=%EC%
pause
exit /b %EC%
