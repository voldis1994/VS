@echo off
REM REBUILD_ALL.bat — stop everything, pull main, npm install, rebuild calc+UI, start fresh
REM
REM Use after git pull when robots still show old behaviour (TRAIL skip, BUY TREND_DOWN, etc.)
REM
REM   cd /d C:\VS
REM   REBUILD_ALL.bat
REM
REM Full clean (delete node_modules first — slower):
REM   set VS_REBUILD_CLEAN=1
REM   REBUILD_ALL.bat
REM
REM Offline / skip git:
REM   set VS_REBUILD_SKIP_PULL=1
REM   REBUILD_ALL.bat
setlocal EnableExtensions
cd /d "%~dp0"

echo ########################################
echo #  VS — REBUILD ALL (from scratch)
echo ########################################

if not exist "%~dp0ADMIN\windows\rebuild-all.ps1" (
  echo FAIL: missing ADMIN\windows\rebuild-all.ps1
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ADMIN\windows\rebuild-all.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo REBUILD_ALL FAILED — see output above
  pause
  exit /b %ERR%
)

echo.
echo REBUILD_ALL OK — desk http://127.0.0.1:3000/robot
pause
exit /b 0
