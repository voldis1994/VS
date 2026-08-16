@echo off
REM VIENA KOMANDA — MSI ADMIN
REM   cd C:\VS-main
REM   git pull
REM   START_MSI.bat
REM
REM If discover fails: put i3 LAN IP (one line) in ADMIN\config\SERVER_IP.txt
REM   example: 192.168.0.10
setlocal EnableExtensions
cd /d "%~dp0"

echo ########################################
echo #  VS — START_MSI (ADMIN Control Panel)
echo ########################################

where git >nul 2>&1
if not errorlevel 1 (
  git pull origin main 2>nul
)

if not exist "%~dp0ADMIN\config\SERVER_IP.txt" (
  if exist "%~dp0ADMIN\config\SERVER_IP.txt.example" (
    echo NOTE: create ADMIN\config\SERVER_IP.txt with i3 LAN IP ^(one line^)
    echo   copy ADMIN\config\SERVER_IP.txt.example ADMIN\config\SERVER_IP.txt
    echo   then edit to match: hostname -I on i3
  )
)

if exist "%~dp0ADMIN\START_EVERYTHING.bat" (
  call "%~dp0ADMIN\START_EVERYTHING.bat"
  exit /b %ERRORLEVEL%
)

if exist "%~dp0ADMIN\START_ADMIN.bat" (
  if not exist "%~dp0ADMIN\desktop\node_modules" (
    call "%~dp0ADMIN\INSTALL_ADMIN.bat"
    if errorlevel 1 ( pause & exit /b 1 )
  )
  call "%~dp0ADMIN\START_ADMIN.bat"
  exit /b %ERRORLEVEL%
)

echo FAIL: ADMIN mape nav — atver pareizo VS mapi
pause
exit /b 1
