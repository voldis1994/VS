@echo off
REM PALAID.bat — vecais operators vards (no old version).
REM Tikai palaiž ESOŠO VS Admin.exe — neko nelejumielade.
REM Canonical implementation: START_MSI.bat (native VS Admin, no browser).
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0START_MSI.bat" (
  echo NAV START_MSI.bat — sis nav VS mape. Izmanto C:\VS-main
  pause
  exit /b 1
)

call "%~dp0START_MSI.bat"
exit /b %ERRORLEVEL%
