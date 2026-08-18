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
set /p _VS_IP=<"%~dp0ADMIN\config\SERVER_IP.txt"
if "%_VS_IP%"=="" (
  echo FAIL: ADMIN\config\SERVER_IP.txt is empty
  echo Run: echo 192.168.0.10^> ADMIN\config\SERVER_IP.txt
  pause
  exit /b 1
)

if not exist "%~dp0ADMIN\windows\dist\VS Admin.exe" (
  echo VS Admin.exe missing — trying BUILD_ADMIN.bat once
  call "%~dp0ADMIN\windows\BUILD_ADMIN.bat"
  if errorlevel 1 (
    echo WARN: exe build failed — START will use python ADMIN\desktop\main.py
  )
)

if exist "%~dp0ADMIN\PHYSICAL_VERIFY.bat" (
  echo Tip: run ADMIN\PHYSICAL_VERIFY.bat first if CONNECT fails identity.
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
