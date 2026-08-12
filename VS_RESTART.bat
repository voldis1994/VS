@echo off
cd /d "%~dp0"
if exist "%~dp0scripts\vs_restart_full.bat" (
  call "%~dp0scripts\vs_restart_full.bat"
  exit /b %ERRORLEVEL%
)
echo [FAIL] scripts\vs_restart_full.bat missing
pause
exit /b 1
