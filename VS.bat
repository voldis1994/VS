@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "ROOT=%CD%"
title VS - palaisana (NEAIZVER SO LOGU)
color 0A

echo.
echo ============================================================
echo   VS  -  KOMANDU PANELIS  (ne PowerShell, ne Expand-Archive)
echo ============================================================
echo   Mape: %ROOT%
echo.

if not exist "%ROOT%\apps\dashboard\package.json" (
  color 0C
  echo [KLUDA] Sis nav VS mape.
  pause
  exit /b 1
)

echo [..] Nemu jaunako VS.exe no GitHub...
curl.exe -fL --retry 3 -o "%TEMP%\VS-app.exe" "https://raw.githubusercontent.com/voldis1994/VS/main/VS.exe"
set "OKEXE=0"
if exist "%TEMP%\VS-app.exe" (
  for %%A in ("%TEMP%\VS-app.exe") do if %%~zA GEQ 1000000 set "OKEXE=1"
)
if not "!OKEXE!"=="1" (
  curl.exe -fL --retry 3 -o "%TEMP%\VS-app.exe" "https://github.com/voldis1994/VS/raw/main/VS.exe"
  if exist "%TEMP%\VS-app.exe" (
    for %%A in ("%TEMP%\VS-app.exe") do if %%~zA GEQ 1000000 set "OKEXE=1"
  )
)
if "!OKEXE!"=="1" (
  echo [OK] palaižu paneli
  start "" "%TEMP%\VS-app.exe" "%ROOT%"
  exit /b 0
)
if exist "%ROOT%\VS.exe" (
  echo [WARN] GitHub exe neizdevas - palaižu lokalo VS.exe
  start "" "%ROOT%\VS.exe" "%ROOT%"
  exit /b 0
)
if exist "%ROOT%\VS_RESTART.exe" (
  echo [WARN] palaižu VS_RESTART.exe
  start "" "%ROOT%\VS_RESTART.exe" "%ROOT%"
  exit /b 0
)

color 0C
echo [KLUDA] VS.exe nav. Internets vajadzigs pirmajai reizei.
pause
exit /b 1
