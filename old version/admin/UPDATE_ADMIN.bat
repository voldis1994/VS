@echo off
REM Update VS ADMIN — pull is operator-controlled; this rebuilds local tree.
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  VS ADMIN UPDATE
echo ========================================
echo Ensure git pull completed on this tree, then rebuilding ADMIN...

if not exist "%~dp0windows\install-admin.ps1" (
  echo FAIL: missing windows\install-admin.ps1
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install-admin.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo UPDATE FAILED
  exit /b %ERR%
)
echo UPDATE OK — run START_ADMIN.bat
exit /b 0
