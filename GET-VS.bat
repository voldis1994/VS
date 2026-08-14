@echo off
REM Vecais VS.bat ir salauzts — sis TIKAI izsauc FIX.ps1
cd /d "%~dp0"
echo Palaizu FIX.ps1 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/voldis1994/VS/main/FIX.ps1 | iex"
if errorlevel 1 (
  echo.
  echo Ja irm neiet, dari:
  echo   cd /d C:\VS-main
  echo   powershell -NoProfile -ExecutionPolicy Bypass -File FIX.ps1
  echo.
  echo Vai lejupielade FIX.ps1 no GitHub un dubultklikski.
  pause
)
