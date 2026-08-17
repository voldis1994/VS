@echo off
REM VIENA KOMANDA — MSI ADMIN
REM   cd /d C:\VS-main
REM   START_MSI.bat
setlocal EnableExtensions
cd /d "%~dp0"

echo ########################################
echo #  VS — START_MSI
echo ########################################

if not exist "%~dp0ADMIN\desktop\package.json" (
  echo FAIL: palaid no C:\VS-main  ^(tagad esi: %CD%^)
  pause
  exit /b 1
)

where git >nul 2>&1
if not errorlevel 1 (
  git pull origin main 2>nul
)

if not exist "%~dp0ADMIN\config\SERVER_IP.txt" (
  echo Creating ADMIN\config\SERVER_IP.txt default 192.168.0.10
  mkdir "%~dp0ADMIN\config" 2>nul
  echo 192.168.0.10> "%~dp0ADMIN\config\SERVER_IP.txt"
)

if exist "%~dp0ADMIN\PHYSICAL_VERIFY.bat" (
  echo Tip: run ADMIN\PHYSICAL_VERIFY.bat first if CONNECT fails identity.
)
if exist "%~dp0ADMIN\CONNECT_FORCE.bat" (
  call "%~dp0ADMIN\CONNECT_FORCE.bat"
  exit /b %ERRORLEVEL%
)

if exist "%~dp0ADMIN\START_ADMIN.bat" (
  call "%~dp0ADMIN\START_ADMIN.bat"
  exit /b %ERRORLEVEL%
)

echo FAIL: ADMIN scripts missing
pause
exit /b 1
