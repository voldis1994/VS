@echo off
REM Canonical MSI start — ONE computer, no i3 server.
REM   cd /d C:\VS
REM   START_MSI.bat
setlocal EnableExtensions
cd /d "%~dp0"

echo ########################################
echo #  VS — START_MSI (one PC)
echo ########################################

if not exist "%~dp0ADMIN\web\index.html" (
  echo FAIL: not VS repo root. Use C:\VS
  echo cwd=%CD%
  pause
  exit /b 1
)

if not exist "%~dp0ADMIN\windows\start-admin.ps1" (
  echo FAIL: missing ADMIN\windows\start-admin.ps1
  pause
  exit /b 1
)

where git >nul 2>&1
if not errorlevel 1 (
  echo Syncing origin/main — hard reset
  git fetch origin main
  if errorlevel 1 (
    echo FAIL: git fetch origin main failed
    pause
    exit /b 1
  )
  git checkout main
  git reset --hard origin/main
  if errorlevel 1 (
    echo FAIL: git reset --hard origin/main failed
    pause
    exit /b 1
  )
  git log -1 --oneline
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ADMIN\windows\start-admin.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo START_MSI FAILED
  pause
  exit /b %ERR%
)
exit /b 0
