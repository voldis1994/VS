@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

echo ========================================
echo  VS CLIENT START
echo ========================================

if not exist "desktop\package.json" (
  echo FAIL: CLIENT\desktop missing — incomplete package
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [CONFIG_REQUIRED] Node.js required only for repository/dev packages.
  echo Packaged VS_CLIENT_SETUP.exe must ship a prebuilt binary without Node.
  if exist "desktop\dist\index.html" (
    echo Opening prebuilt UI...
    start "" "desktop\dist\index.html"
    exit /b 0
  )
  exit /b 2
)

if not exist "desktop\node_modules" (
  echo Installing CLIENT desktop dependencies...
  pushd desktop
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo FAIL: npm install
    popd
    exit /b 1
  )
  popd
)

echo Launching VS CLIENT desktop against WireGuard CLIENT API ^(10.77.0.1^)...
pushd desktop
start "" cmd /c "npm run preview -- --host 127.0.0.1 --port 5174"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:5174/"
popd
echo VS CLIENT started. Close the preview window to stop.
exit /b 0
