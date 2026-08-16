@echo off
REM =============================================================================
REM START_ADMIN.bat — start REAL Control Panel against i3 VS-CORE-01
REM Does NOT start Postgres/Redis/server backend on this PC.
REM =============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\start-admin.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo START FAILED
  pause
  exit /b %ERR%
)
exit /b 0
