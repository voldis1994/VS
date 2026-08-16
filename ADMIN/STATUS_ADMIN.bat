@echo off
REM =============================================================================
REM STATUS_ADMIN.bat — connection status to i3 VS-CORE-01 (real health/snapshot)
REM =============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\status-admin.ps1"
set "ERR=%ERRORLEVEL%"
pause
exit /b %ERR%
