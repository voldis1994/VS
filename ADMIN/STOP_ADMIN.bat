@echo off
REM =============================================================================
REM STOP_ADMIN.bat — stop local Control Panel (Vite) on this Windows PC
REM =============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\stop-admin.ps1"
exit /b %ERRORLEVEL%
