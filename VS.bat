@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "ROOT=%CD%"
title VS - palaisana (NEAIZVER SO LOGU)
color 0A

echo.
echo ============================================================
echo   VS  KOMANDU PANELIS
echo ============================================================
echo   Mape: %ROOT%
echo.

if not exist "%ROOT%\apps\dashboard\package.json" (
  color 0C
  echo [KLUDA] Sis nav VS mape.
  pause
  exit /b 1
)

echo [1] Apturu VISU kas tureja veco VS.exe / Node...
taskkill /F /T /IM VS.exe >nul 2>&1
taskkill /F /T /IM VS_RESTART.exe >nul 2>&1
taskkill /F /T /IM node.exe >nul 2>&1
taskkill /F /T /IM npm.exe >nul 2>&1
taskkill /F /T /IM tsx.exe >nul 2>&1
timeout /t 3 /nobreak >nul

REM Ja VS.exe vel aizslegts — atkartoti del (copy klusi atstaja VECU failu)
set "KILLTRY=0"
:kill_loop
set /a KILLTRY+=1
taskkill /F /T /IM VS.exe >nul 2>&1
del /f /q "%ROOT%\VS.exe" >nul 2>&1
if exist "%ROOT%\VS.exe" (
  if !KILLTRY! LSS 10 (
    echo [..] VS.exe vel aizslegts — meginu velreiz !KILLTRY!/10
    timeout /t 1 /nobreak >nul
    goto kill_loop
  )
  color 0C
  echo [KLUDA] Nevaru izdzest VS.exe — aizver Task Manager VISUS VS.exe, tad palaid VS.bat velreiz.
  pause
  exit /b 1
)
echo [OK] vecais VS.exe nav (dzests)

echo [2] Lejupieladeju JAUNO VS.exe no GitHub...
del /f /q "%ROOT%\VS.exe.new" >nul 2>&1
curl.exe -fL --retry 5 --retry-delay 2 -o "%ROOT%\VS.exe.new" "https://raw.githubusercontent.com/voldis1994/VS/main/VS.exe"
set "OKEXE=0"
if exist "%ROOT%\VS.exe.new" (
  for %%A in ("%ROOT%\VS.exe.new") do (
    echo      lejupielade: %%~zA bytes
    if %%~zA GEQ 1000000 set "OKEXE=1"
  )
)
if not "!OKEXE!"=="1" (
  echo [..] raw neizdevas — meginu github.com/raw ...
  curl.exe -fL --retry 5 --retry-delay 2 -o "%ROOT%\VS.exe.new" "https://github.com/voldis1994/VS/raw/main/VS.exe"
  if exist "%ROOT%\VS.exe.new" (
    for %%A in ("%ROOT%\VS.exe.new") do (
      echo      lejupielade: %%~zA bytes
      if %%~zA GEQ 1000000 set "OKEXE=1"
    )
  )
)
if not "!OKEXE!"=="1" (
  color 0C
  echo [KLUDA] VS.exe lejupielade FAIL — parbaudi internetu. VECU exe NEPALAIZU.
  pause
  exit /b 1
)

move /Y "%ROOT%\VS.exe.new" "%ROOT%\VS.exe" >nul
if not exist "%ROOT%\VS.exe" (
  color 0C
  echo [KLUDA] move uz VS.exe neizdevas.
  pause
  exit /b 1
)
for %%A in ("%ROOT%\VS.exe") do (
  echo [OK] jaunais VS.exe uzlikts — %%~zA bytes
  if %%~zA LSS 1000000 (
    color 0C
    echo [KLUDA] VS.exe parak mazs — apturu.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Unblock-File -LiteralPath '%ROOT%\VS.exe' } catch {}" >nul 2>&1

echo.
echo ============================================================
echo   PANELIS:  http://127.0.0.1:18090
echo   Kartina LAUNCHER jabut ID (ne tuksam).
echo   Ja redzi veco [2/5] GitHub update PIRMS Postgres — tas VEL ir vecais exe.
echo ============================================================
echo.

start "" "%ROOT%\VS.exe" "%ROOT%"
timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:18090"

echo [OK] palaisa. NEAIZVER so logu lidz panelis radaa LAUNCHER.
echo.
pause
exit /b 0
