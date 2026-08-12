@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ============================================================
REM  MARKET READER - ONE CLICK FIRST RUN (Windows 11 x64)
REM  Double-click this file from the repo root.
REM ============================================================

cd /d "%~dp0"
set "ROOT=%CD%"
set "LOG=%ROOT%\logs\first_run.log"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs" >nul 2>&1

echo.
echo ============================================================
echo   MARKET READER - FIRST RUN
echo   Repo: %ROOT%
echo   Log:  %LOG%
echo ============================================================
echo.
echo Starting automatically. Do not close this window.
echo.

call :log "=== FIRST RUN START ==="
echo [0/9] Loading MSVC environment if needed...
call :ensure_msvc
echo [0/9] Done.

echo.
echo [1/9] Checking required tools...
set "MISSING=0"
call :need_tool git "Git" "winget install --id Git.Git -e"
call :need_tool cmake "CMake" "winget install --id Kitware.CMake -e"
call :need_tool node "Node.js LTS" "winget install --id OpenJS.NodeJS.LTS -e"
call :need_tool npm "npm" "Reinstall Node.js LTS"
call :need_tool docker "Docker Desktop" "winget install --id Docker.DockerDesktop -e"

where cl >nul 2>&1
if errorlevel 1 (
  echo [MISSING] MSVC cl.exe
  echo          Install VS 2022 Build Tools with C++ workload, then run again.
  echo          winget install --id Microsoft.VisualStudio.2022.BuildTools -e
  set "MISSING=1"
) else (
  echo [OK] MSVC cl.exe
)

if "!MISSING!"=="1" goto :fail

echo.
echo [2/9] Preparing .env ...
if not exist "%ROOT%\.env" (
  if not exist "%ROOT%\.env.example" (
    echo [FAIL] .env.example missing
    goto :fail
  )
  copy /Y "%ROOT%\.env.example" "%ROOT%\.env" >nul
  echo [OK] Created .env from .env.example
) else (
  echo [OK] .env already exists - not overwritten
)

echo.
echo [3/9] Preparing vcpkg ...
if not defined VCPKG_ROOT (
  if exist "%USERPROFILE%\vcpkg\vcpkg.exe" (
    set "VCPKG_ROOT=%USERPROFILE%\vcpkg"
  ) else (
    echo Cloning vcpkg...
    git clone https://github.com/microsoft/vcpkg.git "%USERPROFILE%\vcpkg"
    if errorlevel 1 goto :fail
    call "%USERPROFILE%\vcpkg\bootstrap-vcpkg.bat" -disableMetrics
    if errorlevel 1 goto :fail
    set "VCPKG_ROOT=%USERPROFILE%\vcpkg"
  )
)
if not exist "%VCPKG_ROOT%\vcpkg.exe" (
  echo [FAIL] vcpkg.exe not found at %VCPKG_ROOT%
  goto :fail
)
echo [OK] VCPKG_ROOT=%VCPKG_ROOT%
echo Installing C++ dependencies ^(this can take a while^)...
"%VCPKG_ROOT%\vcpkg.exe" install --triplet x64-windows
if errorlevel 1 goto :fail
echo [OK] vcpkg dependencies installed

echo.
echo [4/9] Building C++ Debug ...
cmake --preset windows-debug
if errorlevel 1 goto :fail
cmake --build build\windows-debug --config Debug
if errorlevel 1 goto :fail
if not exist "%ROOT%\build\windows-debug\apps\market-core\market-core.exe" (
  echo [FAIL] market-core.exe missing after build
  goto :fail
)
if not exist "%ROOT%\build\windows-debug\apps\execution-service\execution-service.exe" (
  echo [FAIL] execution-service.exe missing after build
  goto :fail
)
echo [OK] C++ Debug build ready

echo.
echo [5/9] Installing npm packages ...
pushd "%ROOT%\apps\control-api"
call npm install
if errorlevel 1 (
  popd
  goto :fail
)
popd
pushd "%ROOT%\apps\dashboard"
call npm install
if errorlevel 1 (
  popd
  goto :fail
)
popd
echo [OK] npm packages installed

echo.
echo [6/9] Starting PostgreSQL + Redis ...
docker info >nul 2>&1
if errorlevel 1 (
  echo [FAIL] Docker is installed but not running. Start Docker Desktop and re-run.
  goto :fail
)
docker compose -f "%ROOT%\docker-compose.yml" up -d postgres redis
if errorlevel 1 goto :fail

echo Waiting for PostgreSQL...
set "READY=0"
for /L %%i in (1,1,30) do (
  docker compose -f "%ROOT%\docker-compose.yml" exec -T postgres pg_isready -U market_reader -d market_reader >nul 2>&1
  if not errorlevel 1 (
    set "READY=1"
    goto :pg_ready
  )
  ping -n 3 127.0.0.1 >nul
)
:pg_ready
if "!READY!"=="0" (
  echo [FAIL] PostgreSQL not ready. Run: docker compose ps
  goto :fail
)
echo [OK] PostgreSQL is ready

echo.
echo [7/9] Running database migrations ...
pushd "%ROOT%\apps\control-api"
call npm run migrate
if errorlevel 1 (
  popd
  echo [FAIL] Migration failed. Check DB_PASSWORD in .env
  goto :fail
)
popd
echo [OK] Migrations applied

echo.
echo [8/9] Starting all services ...
taskkill /F /IM market-core.exe >nul 2>&1
taskkill /F /IM execution-service.exe >nul 2>&1

start "MR-MarketCore" /D "%ROOT%" cmd /k build\windows-debug\apps\market-core\market-core.exe --mode PAPER --config config --record data\raw\events.mrev
ping -n 3 127.0.0.1 >nul
start "MR-Execution" /D "%ROOT%" cmd /k build\windows-debug\apps\execution-service\execution-service.exe --mode PAPER
ping -n 3 127.0.0.1 >nul
start "MR-ControlAPI" /D "%ROOT%\apps\control-api" cmd /k npm run dev
ping -n 6 127.0.0.1 >nul
start "MR-Dashboard" /D "%ROOT%\apps\dashboard" cmd /k npm run dev
ping -n 6 127.0.0.1 >nul

echo.
echo [9/9] Checking API health ...
set "API_OK=0"
for /L %%i in (1,1,30) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing http://localhost:3000/health -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }"
  if not errorlevel 1 (
    set "API_OK=1"
    goto :api_ready
  )
  ping -n 3 127.0.0.1 >nul
)
:api_ready
if "!API_OK!"=="0" (
  echo [WARN] API health timed out. Check MR-ControlAPI window.
) else (
  echo [OK] Control API is healthy
)

start "" http://localhost:5173

echo.
echo ============================================================
echo   SETUP COMPLETE - SYSTEM RUNNING
echo ============================================================
echo   Dashboard:   http://localhost:5173
echo   Control API: http://localhost:3000/health
echo.
echo   Windows opened:
echo     MR-MarketCore, MR-Execution, MR-ControlAPI, MR-Dashboard
echo.
echo   Stop later with: scripts\stop.bat
echo ============================================================
call :log "=== FIRST RUN SUCCESS ==="
echo.
echo Press any key to close this setup window...
pause >nul
exit /b 0

:fail
echo.
echo ============================================================
echo   FIRST RUN FAILED
echo ============================================================
echo   Read the error above, fix it, then run START_HERE.bat again.
echo   Log: %LOG%
echo ============================================================
call :log "=== FIRST RUN FAILED ==="
echo.
echo Press any key to close...
pause >nul
exit /b 1

:need_tool
where %~1 >nul 2>&1
if errorlevel 1 (
  echo [MISSING] %~2
  echo          Install: %~3
  set "MISSING=1"
) else (
  echo [OK] %~2
)
goto :eof

:ensure_msvc
where cl >nul 2>&1
if not errorlevel 1 (
  echo [OK] MSVC already in PATH
  goto :eof
)
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo [WARN] vswhere not found
  goto :eof
)
set "VSINSTALL="
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if not defined VSINSTALL (
  echo [WARN] Visual Studio C++ tools not found
  goto :eof
)
if exist "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" (
  echo Loading MSVC from %VSINSTALL%
  call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul
)
where cl >nul 2>&1
if errorlevel 1 (
  echo [WARN] cl.exe still not found after vcvars64
) else (
  echo [OK] MSVC environment loaded
)
goto :eof

:log
>>"%LOG%" echo [%DATE% %TIME%] %~1
goto :eof
