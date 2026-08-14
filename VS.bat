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

echo [..] Nemu jaunako VS.exe no GitHub uz so mapi...
curl.exe -fL --retry 3 -o "%ROOT%\VS.exe.new" "https://raw.githubusercontent.com/voldis1994/VS/main/VS.exe"
set "OKEXE=0"
if exist "%ROOT%\VS.exe.new" (
  for %%A in ("%ROOT%\VS.exe.new") do if %%~zA GEQ 1000000 set "OKEXE=1"
)
if not "!OKEXE!"=="1" (
  curl.exe -fL --retry 3 -o "%ROOT%\VS.exe.new" "https://github.com/voldis1994/VS/raw/main/VS.exe"
  if exist "%ROOT%\VS.exe.new" (
    for %%A in ("%ROOT%\VS.exe.new") do if %%~zA GEQ 1000000 set "OKEXE=1"
  )
)
if "!OKEXE!"=="1" (
  copy /Y "%ROOT%\VS.exe.new" "%ROOT%\VS.exe" >nul
  del /f /q "%ROOT%\VS.exe.new" >nul 2>&1
)

if not exist "%ROOT%\VS.exe" (
  color 0C
  echo [KLUDA] VS.exe nav. Parbaudi internetu.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Unblock-File -LiteralPath '%ROOT%\VS.exe' } catch {}" >nul 2>&1

echo.
echo ============================================================
echo   PANELIS:  http://127.0.0.1:18090
echo   Ja Chrome neatveras — IEKOPĒ TO ADRESI PĀRLŪKĀ.
echo   SO LOGU NEAIZVER lidz panelis ir redzams.
echo ============================================================
echo.

start "" "%ROOT%\VS.exe" "%ROOT%"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:18090"

echo [OK] VS.exe palaisa. Panelis: http://127.0.0.1:18090
echo.
pause
exit /b 0
