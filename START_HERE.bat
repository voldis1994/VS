@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ============================================================
REM  MARKET READER - ONE CLICK FIRST RUN (Windows 11 x64)
REM  Double-click this file OR run from repo root:
REM      START_HERE.bat
REM ============================================================

cd /d "%~dp0"
set "ROOT=%CD%"
set "LOG=%ROOT%\logs\first_run.log"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"

echo.
echo ============================================================
echo   MARKET READER - FIRST RUN
echo   Repo: %ROOT%
echo   Log:  %LOG%
echo ============================================================
echo.
echo This script will:
echo   1. Check tools (Git, MSVC, CMake, Node, Docker)
echo   2. Create .env if missing
echo   3. Bootstrap vcpkg + install C++ deps
echo   4. Build C++ Debug
echo   5. Install backend + dashboard npm packages
echo   6. Start PostgreSQL (Docker)
echo   7. Run database migrations
echo   8. Start Market Core, Execution, API, Dashboard
echo   9. Open the dashboard in your browser
echo.
echo Press any key to start...
pause >nul

call :log "=== FIRST RUN START %DATE% %TIME% ==="

REM ------------------------------------------------------------
REM 0) Prefer MSVC x64 developer environment
REM ------------------------------------------------------------
call :ensure_msvc
if errorlevel 1 goto :fail

REM ------------------------------------------------------------
REM 1) Tool checks
REM ------------------------------------------------------------
echo.
echo [1/9] Checking required tools...
set "MISSING=0"

call :need_tool git "Git" "winget install --id Git.Git -e --source winget"
call :need_tool cmake "CMake" "winget install --id Kitware.CMake -e --source winget"
call :need_tool node "Node.js LTS" "winget install --id OpenJS.NodeJS.LTS -e --source winget"
call :need_tool npm "npm (comes with Node.js)" "Reinstall Node.js LTS"
call :need_tool docker "Docker Desktop" "winget install --id Docker.DockerDesktop -e --source winget"

where cl >nul 2>&1
if errorlevel 1 (
    echo [MISSING] MSVC C++ compiler ^(cl.exe^)
    echo          Install Visual Studio 2022 Build Tools with "Desktop development with C++"
    echo          winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget
    echo          Then reopen this script from "x64 Native Tools Command Prompt for VS" if needed.
    set "MISSING=1"
) else (
    echo [OK] MSVC cl.exe
)

if "!MISSING!"=="1" (
    echo.
    echo ------------------------------------------------------------
    echo STOPPED: install the missing tools above, then run START_HERE.bat again.
    echo ------------------------------------------------------------
    goto :fail
)

REM ------------------------------------------------------------
REM 2) .env
REM ------------------------------------------------------------
echo.
echo [2/9] Preparing .env ...
if not exist "%ROOT%\.env" (
    if not exist "%ROOT%\.env.example" (
        echo [FAIL] .env.example not found in repo root.
        goto :fail
    )
    copy /Y "%ROOT%\.env.example" "%ROOT%\.env" >nul
    echo [OK] Created .env from .env.example
    echo [NOTE] Default passwords are placeholders. Change them later in .env if needed.
) else (
    echo [OK] .env already exists - NOT overwritten
)

REM ------------------------------------------------------------
REM 3) vcpkg
REM ------------------------------------------------------------
echo.
echo [3/9] Preparing vcpkg ...
if not defined VCPKG_ROOT (
    if exist "%USERPROFILE%\vcpkg\vcpkg.exe" (
        set "VCPKG_ROOT=%USERPROFILE%\vcpkg"
    ) else (
        echo Cloning vcpkg to %USERPROFILE%\vcpkg ...
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
setx VCPKG_ROOT "%VCPKG_ROOT%" >nul 2>&1
echo [OK] VCPKG_ROOT=%VCPKG_ROOT%

echo Installing C++ dependencies via vcpkg manifest...
"%VCPKG_ROOT%\vcpkg.exe" install --triplet x64-windows
if errorlevel 1 (
    echo [FAIL] vcpkg install failed. See log: %LOG%
    goto :fail
)
echo [OK] vcpkg dependencies installed

REM ------------------------------------------------------------
REM 4) C++ Debug build
REM ------------------------------------------------------------
echo.
echo [4/9] Configuring and building C++ Debug ...
cmake --preset windows-debug
if errorlevel 1 (
    echo [FAIL] CMake configure failed.
    echo        Tip: run from "x64 Native Tools Command Prompt for VS 2022"
    goto :fail
)
cmake --build build/windows-debug --config Debug
if errorlevel 1 (
    echo [FAIL] C++ Debug build failed.
    goto :fail
)

if not exist "%ROOT%\build\windows-debug\apps\market-core\market-core.exe" (
    echo [FAIL] market-core.exe not found after build.
    goto :fail
)
if not exist "%ROOT%\build\windows-debug\apps\execution-service\execution-service.exe" (
    echo [FAIL] execution-service.exe not found after build.
    goto :fail
)
echo [OK] C++ Debug build ready

REM ------------------------------------------------------------
REM 5) npm installs
REM ------------------------------------------------------------
echo.
echo [5/9] Installing Node dependencies ...
pushd "%ROOT%\apps\control-api"
call npm install
if errorlevel 1 (
    popd
    echo [FAIL] control-api npm install failed
    goto :fail
)
popd

pushd "%ROOT%\apps\dashboard"
call npm install
if errorlevel 1 (
    popd
    echo [FAIL] dashboard npm install failed
    goto :fail
)
popd
echo [OK] npm packages installed

REM ------------------------------------------------------------
REM 6) Docker / PostgreSQL
REM ------------------------------------------------------------
echo.
echo [6/9] Starting PostgreSQL + Redis via Docker Compose ...
docker info >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Docker is installed but not running.
    echo        Start Docker Desktop, wait until it is ready, then run START_HERE.bat again.
    goto :fail
)

docker compose -f "%ROOT%\docker-compose.yml" up -d postgres redis
if errorlevel 1 (
    echo [FAIL] docker compose up failed
    goto :fail
)

echo Waiting for PostgreSQL to become healthy...
set "READY=0"
for /L %%i in (1,1,30) do (
    docker compose -f "%ROOT%\docker-compose.yml" exec -T postgres pg_isready -U market_reader -d market_reader >nul 2>&1
    if not errorlevel 1 (
        set "READY=1"
        goto :pg_ready
    )
    timeout /t 2 /nobreak >nul
)
:pg_ready
if "!READY!"=="0" (
    echo [FAIL] PostgreSQL did not become ready in time.
    echo        Check: docker compose ps
    goto :fail
)
echo [OK] PostgreSQL is ready

REM ------------------------------------------------------------
REM 7) Migrations
REM ------------------------------------------------------------
echo.
echo [7/9] Running database migrations ...
pushd "%ROOT%\apps\control-api"
call npm run migrate
if errorlevel 1 (
    popd
    echo [FAIL] DB migration failed. Check DB_PASSWORD in .env matches docker-compose.
    goto :fail
)
popd
echo [OK] Migrations applied

REM ------------------------------------------------------------
REM 8) Start all services
REM ------------------------------------------------------------
echo.
echo [8/9] Starting all services ...

REM Stop previous instances if any
taskkill /F /IM market-core.exe >nul 2>&1
taskkill /F /IM execution-service.exe >nul 2>&1

start "MR-MarketCore" cmd /k "cd /d "%ROOT%" && build\windows-debug\apps\market-core\market-core.exe --mode PAPER --config config --record data\raw\events.mrev"
timeout /t 2 /nobreak >nul

start "MR-Execution" cmd /k "cd /d "%ROOT%" && build\windows-debug\apps\execution-service\execution-service.exe --mode PAPER"
timeout /t 2 /nobreak >nul

start "MR-ControlAPI" cmd /k "cd /d "%ROOT%\apps\control-api" && npm run dev"
timeout /t 5 /nobreak >nul

start "MR-Dashboard" cmd /k "cd /d "%ROOT%\apps\dashboard" && npm run dev"
timeout /t 5 /nobreak >nul

REM ------------------------------------------------------------
REM 9) Smoke check + open browser
REM ------------------------------------------------------------
echo.
echo [9/9] Waiting for Control API health ...
set "API_OK=0"
for /L %%i in (1,1,30) do (
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing http://localhost:3000/health -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
    if not errorlevel 1 (
        set "API_OK=1"
        goto :api_ready
    )
    timeout /t 2 /nobreak >nul
)
:api_ready

if "!API_OK!"=="0" (
    echo [WARN] API health check timed out.
    echo        Check the "MR-ControlAPI" window for errors.
) else (
    echo [OK] Control API is healthy
)

echo Opening dashboard...
start "" "http://localhost:5173"

echo.
echo ============================================================
echo   SETUP COMPLETE - SYSTEM RUNNING
echo ============================================================
echo.
echo   Dashboard:  http://localhost:5173
echo   Control API: http://localhost:3000/health
echo.
echo   Open windows:
echo     - MR-MarketCore
echo     - MR-Execution
echo     - MR-ControlAPI
echo     - MR-Dashboard
echo.
echo   To stop everything later:
echo     scripts\stop.bat
echo.
echo   Log file: %LOG%
echo ============================================================
call :log "=== FIRST RUN SUCCESS ==="
pause
exit /b 0

REM ============================================================
REM Helpers
REM ============================================================
:fail
echo.
echo ============================================================
echo   FIRST RUN FAILED
echo ============================================================
echo   Fix the error above, then double-click START_HERE.bat again.
echo   Log: %LOG%
echo ============================================================
call :log "=== FIRST RUN FAILED ==="
pause
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
    exit /b 0
)

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [WARN] vswhere not found - MSVC may be missing from PATH
    exit /b 0
)

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
    set "VSINSTALL=%%i"
)

if not defined VSINSTALL (
    echo [WARN] Visual Studio C++ tools not found via vswhere
    exit /b 0
)

if exist "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" (
    echo Loading MSVC x64 environment from:
    echo   %VSINSTALL%
    call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul
)

where cl >nul 2>&1
if errorlevel 1 (
    echo [WARN] Still could not find cl.exe after vcvars64
    exit /b 0
)
echo [OK] MSVC environment loaded
exit /b 0

:log
>>"%LOG%" echo %DATE% %TIME% %~1
goto :eof
