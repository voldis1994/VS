@echo off
REM FINAL_ACCEPTANCE.bat — MSI ADMIN connectivity check (no fake PASS)
setlocal EnableExtensions
cd /d "%~dp0"

echo VS ADMIN FINAL ACCEPTANCE
echo =========================

if not exist "%~dp0config\control-panel.env" (
  echo [FAIL] missing config\control-panel.env — run INSTALL_ADMIN.bat
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\status-admin.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo ADMIN PRODUCT NOT READY
  exit /b %ERR%
)
echo ADMIN PRODUCT READY
exit /b 0
