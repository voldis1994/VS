@echo off
REM VIENA KOMANDA — MSI ADMIN
REM   cd C:\VS-main
REM   git pull
REM   START_MSI.bat
setlocal EnableExtensions
cd /d "%~dp0"

echo ########################################
echo #  VS — START_MSI (ADMIN Control Panel)
echo ########################################

where git >nul 2>&1
if not errorlevel 1 (
  git pull origin main 2>nul
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
