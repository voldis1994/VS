@echo off
REM Pure CMD rebuild - no rebuild-all.ps1 (avoids PowerShell 5.1 parser issues)
setlocal EnableExtensions
cd /d "%~dp0"

echo ########################################
echo #  VS - REBUILD ALL (CMD)
echo ########################################

if not exist "%~dp0ADMIN\windows\start-admin.ps1" (
  echo FAIL: not VS repo root. cd /d C:\VS or C:\VS-main
  pause
  exit /b 1
)

echo.
echo [1/6] STOP...
if exist "%~dp0ADMIN\windows\stop-admin.ps1" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ADMIN\windows\stop-admin.ps1"
)
timeout /t 2 /nobreak >nul

echo.
echo [2/6] GIT pull...
where git >nul 2>&1
if errorlevel 1 (
  echo WARN: git not on PATH - skip pull
) else if not exist "%~dp0.git" (
  echo WARN: no .git folder - run SETUP_GIT.bat first, skip pull
) else if /I "%VS_REBUILD_SKIP_PULL%"=="1" (
  echo skip pull VS_REBUILD_SKIP_PULL=1
) else (
  git fetch origin main
  git checkout main
  git pull origin main
  if errorlevel 1 echo WARN: git pull failed - continuing
  git log -1 --oneline
)

where node >nul 2>&1
if errorlevel 1 (
  echo FAIL: Node.js required - https://nodejs.org/
  pause
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo FAIL: npm missing
  pause
  exit /b 1
)

echo.
echo [3/6] NPM install...
if /I "%VS_REBUILD_CLEAN%"=="1" (
  echo VS_REBUILD_CLEAN=1 - removing node_modules...
  if exist "%~dp0SERVER\control-api\node_modules" rmdir /s /q "%~dp0SERVER\control-api\node_modules"
  if exist "%~dp0ADMIN\desk\node_modules" rmdir /s /q "%~dp0ADMIN\desk\node_modules"
  if exist "%~dp0CLIENT\web\node_modules" rmdir /s /q "%~dp0CLIENT\web\node_modules"
)
pushd "%~dp0SERVER\control-api"
call npm install --include=dev
if errorlevel 1 goto :fail
popd
pushd "%~dp0ADMIN\desk"
call npm install --include=dev
if errorlevel 1 goto :fail
popd
pushd "%~dp0CLIENT\web"
call npm install --include=dev
if errorlevel 1 goto :fail
popd

echo.
echo [4/6] BUILD C++ vs-calc...
if exist "%~dp0SERVER\calc\BUILD_CALC.bat" (
  pushd "%~dp0SERVER\calc"
  call BUILD_CALC.bat
  popd
)
if exist "%~dp0SERVER\calc\vs-calc.exe" (
  echo OK vs-calc.exe
) else (
  echo WARN: vs-calc.exe missing - install g++
)

echo.
echo [5/6] BUILD desk + client...
if exist "%~dp0ADMIN\desk\dist" rmdir /s /q "%~dp0ADMIN\desk\dist"
pushd "%~dp0ADMIN\desk"
call npx vite build
if errorlevel 1 goto :fail
popd
if exist "%~dp0CLIENT\web\dist" rmdir /s /q "%~dp0CLIENT\web\dist"
pushd "%~dp0CLIENT\web"
call npx vite build
if errorlevel 1 goto :fail
popd

echo.
echo [6/6] START...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ADMIN\windows\start-admin.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" goto :fail

echo.
echo REBUILD_ALL OK - http://127.0.0.1:3000/robot
pause
exit /b 0

:fail
echo.
echo REBUILD_ALL FAILED
pause
exit /b 1
