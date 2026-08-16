@echo off
REM =============================================================================
REM START_ADMIN.bat — ONLY canonical ADMIN/desktop (VS ADMIN)
REM Never starts legacy-review tactical desk.
REM =============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  VS ADMIN START
echo  Canonical UI: ADMIN\desktop
echo  Port: 5188
echo ========================================

if not exist "%~dp0desktop\package.json" (
  echo FAIL: ADMIN\desktop missing — pull latest main and run INSTALL_ADMIN.bat
  pause
  exit /b 1
)

findstr /C:"@vs/admin-desktop" "%~dp0desktop\package.json" >nul
if errorlevel 1 (
  echo FAIL: wrong package — expected @vs/admin-desktop
  pause
  exit /b 1
)

findstr /C:"VS ADMIN" "%~dp0desktop\index.html" >nul
if errorlevel 1 (
  echo FAIL: desktop\index.html is not VS ADMIN
  pause
  exit /b 1
)

if not exist "%~dp0windows\start-admin.ps1" (
  echo FAIL: missing windows\start-admin.ps1
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\start-admin.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo START FAILED
  pause
  exit /b %ERR%
)
exit /b 0
