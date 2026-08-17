@echo off
REM Canonical MSI operator entrypoint. Rewrite this file — do not add START_MSI_NEW.bat
REM   cd /d C:\VS-main
REM   START_MSI.bat
setlocal EnableExtensions
cd /d "%~dp0"

echo ########################################
echo #  VS ADMIN — START_MSI
echo ########################################

if not exist "%~dp0ADMIN\desktop\main.py" (
  echo FAIL: not VS repo root. Use C:\VS-main
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
  git pull origin main 2>nul
)

if not exist "%~dp0ADMIN\config\SERVER_IP.txt" (
  echo FAIL: create ADMIN\config\SERVER_IP.txt with the i3 LAN IP from hostname -I
  echo Example: echo 192.168.0.10^> ADMIN\config\SERVER_IP.txt
  pause
  exit /b 1
)

if not exist "%~dp0ADMIN\windows\dist\VS Admin.exe" (
  echo VS Admin.exe missing — building once via ADMIN\windows\BUILD_ADMIN.bat
  call "%~dp0ADMIN\windows\BUILD_ADMIN.bat"
  if errorlevel 1 (
    echo START_MSI FAILED — native build required
    pause
    exit /b 1
  )
)

if exist "%~dp0ADMIN\PHYSICAL_VERIFY.bat" (
  echo Tip: run ADMIN\PHYSICAL_VERIFY.bat first if CONNECT fails identity.
)
if exist "%~dp0ADMIN\CONNECT_FORCE.bat" (
  call "%~dp0ADMIN\CONNECT_FORCE.bat"
  exit /b %ERRORLEVEL%
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
