@echo off
REM Repair VS ADMIN on Windows MSI — reinstall deps, rebuild, re-validate paths.
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  VS ADMIN REPAIR
echo ========================================

if not exist "%~dp0windows\install-admin.ps1" (
  echo FAIL: missing windows\install-admin.ps1
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install-admin.ps1" -Repair
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo REPAIR FAILED
  exit /b %ERR%
)
echo REPAIR OK
exit /b 0
