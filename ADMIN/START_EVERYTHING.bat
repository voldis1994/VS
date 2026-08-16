@echo off
REM =============================================================================
REM START_EVERYTHING.bat — MSI: install (if needed) + start VS ADMIN
REM Prerequisites: i3 already running (sudo bash SERVER/START_I3.sh)
REM =============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  VS ADMIN — START EVERYTHING
echo ========================================

if not exist "%~dp0windows\start-everything.ps1" (
  echo FAIL: missing windows\start-everything.ps1
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\start-everything.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo START FAILED
  pause
  exit /b %ERR%
)
exit /b 0
