@echo off
REM =============================================================================
REM INSTALL_ADMIN.bat — Windows MSI: install VS ADMIN Control Panel (not the server)
REM Double-click or run from Explorer. No Bash required.
REM =============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  VS ADMIN INSTALL (Windows)
echo ========================================

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install-admin.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo INSTALL FAILED — see messages above.
  pause
  exit /b %ERR%
)
echo.
pause
exit /b 0
