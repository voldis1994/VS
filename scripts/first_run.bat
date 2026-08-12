@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
set "ROOT=%CD%"
set "LOG=%ROOT%\logs\first_run.log"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"

echo ============================================================
echo   MARKET READER - FIRST RUN
echo   Folder: %ROOT%
echo ============================================================
echo.
echo Keep this window open. Progress will print below.
echo.

REM Force delayed expansion only where needed via setlocal in blocks carefully
setlocal EnableDelayedExpansion

call :log START

echo [0/9] MSVC environment...
call :ensure_msvc
echo.

echo [1/9] Checking tools...
set MISSING=0
where git >nul 2>&1 && (echo [OK] Git) || (echo [MISSING] Git & set MISSING=1)
where cmake >nul 2>&1 && (echo [OK] CMake) || (echo [MISSING] CMake & set MISSING=1)
where node >nul 2>&1 && (echo [OK] Node) || (echo [MISSING] Node.js & set MISSING=1)
where npm >nul 2>&1 && (echo [OK] npm) || (echo [MISSING] npm & set MISSING=1)
where docker >nul 2>&1 && (echo [OK] Docker) || (echo [MISSING] Docker Desktop & set MISSING=1)
where cl >nul 2>&1 && (echo [OK] MSVC cl.exe) || (echo [MISSING] MSVC cl.exe & set MISSING=1)

if "!MISSING!"=="1" (
  echo.
  echo Install missing tools, then run START_HERE.bat again.
  echo Git:    winget install Git.Git
  echo CMake:  winget install Kitware.CMake
  echo Node:   winget install OpenJS.NodeJS.LTS
  echo Docker: winget install Docker.DockerDesktop
  echo MSVC:   winget install Microsoft.VisualStudio.2022.BuildTools
  goto fail
)

echo.
echo [2/9] .env file...
if not exist "%ROOT%\.env" (
  copy /Y "%ROOT%\.env.example" "%ROOT%\.env"
  if errorlevel 1 goto fail
  echo [OK] created .env
) else (
  echo [OK] .env exists
)

echo.
echo [3/9] vcpkg...
if not defined VCPKG_ROOT (
  if exist "%USERPROFILE%\vcpkg\vcpkg.exe" set "VCPKG_ROOT=%USERPROFILE%\vcpkg"
)
if not defined VCPKG_ROOT (
  echo Cloning vcpkg - please wait...
  git clone https://github.com/microsoft/vcpkg.git "%USERPROFILE%\vcpkg"
  if errorlevel 1 goto fail
  call "%USERPROFILE%\vcpkg\bootstrap-vcpkg.bat" -disableMetrics
  if errorlevel 1 goto fail
  set "VCPKG_ROOT=%USERPROFILE%\vcpkg"
)
if not exist "%VCPKG_ROOT%\vcpkg.exe" (
  echo [FAIL] no vcpkg.exe
  goto fail
)
echo VCPKG_ROOT=%VCPKG_ROOT%
echo Installing C++ packages - this can take many minutes...
"%VCPKG_ROOT%\vcpkg.exe" install --triplet x64-windows
if errorlevel 1 goto fail
echo [OK] vcpkg done

echo.
echo [4/9] C++ build...
cmake --preset windows-debug
if errorlevel 1 goto fail
cmake --build build\windows-debug --config Debug
if errorlevel 1 goto fail
if not exist "%ROOT%\build\windows-debug\apps\market-core\market-core.exe" goto fail
if not exist "%ROOT%\build\windows-debug\apps\execution-service\execution-service.exe" goto fail
echo [OK] build done

echo.
echo [5/9] npm install...
cd /d "%ROOT%\apps\control-api"
call npm install
if errorlevel 1 goto fail
cd /d "%ROOT%\apps\dashboard"
call npm install
if errorlevel 1 goto fail
cd /d "%ROOT%"
echo [OK] npm done

echo.
echo [6/9] Docker database...
docker info >nul 2>&1
if errorlevel 1 (
  echo [FAIL] Start Docker Desktop first, wait until it is green, then re-run.
  goto fail
)
docker compose up -d postgres redis
if errorlevel 1 goto fail
echo Waiting for Postgres...
set READY=0
for /L %%i in (1,1,40) do (
  docker compose exec -T postgres pg_isready -U market_reader -d market_reader >nul 2>&1
  if not errorlevel 1 (
    set READY=1
    goto pgok
  )
  ping -n 2 127.0.0.1 >nul
)
:pgok
if not "!READY!"=="1" (
  echo [FAIL] Postgres not ready
  goto fail
)
echo [OK] Postgres ready

echo.
echo [7/9] DB migrations...
cd /d "%ROOT%\apps\control-api"
call npm run migrate
if errorlevel 1 goto fail
cd /d "%ROOT%"
echo [OK] migrations done

echo.
echo [8/9] Starting services...
taskkill /F /IM market-core.exe >nul 2>&1
taskkill /F /IM execution-service.exe >nul 2>&1
start "MR-MarketCore" /D "%ROOT%" cmd /k build\windows-debug\apps\market-core\market-core.exe --mode PAPER --config config --record data\raw\events.mrev
ping -n 2 127.0.0.1 >nul
start "MR-Execution" /D "%ROOT%" cmd /k build\windows-debug\apps\execution-service\execution-service.exe --mode PAPER
ping -n 2 127.0.0.1 >nul
start "MR-ControlAPI" /D "%ROOT%\apps\control-api" cmd /k npm run dev
ping -n 5 127.0.0.1 >nul
start "MR-Dashboard" /D "%ROOT%\apps\dashboard" cmd /k npm run dev
ping -n 5 127.0.0.1 >nul

echo.
echo [9/9] Opening browser...
start http://localhost:5173

echo.
echo ============================================================
echo   DONE
echo ============================================================
echo   Dashboard: http://localhost:5173
echo   API:       http://localhost:3000/health
echo.
echo   Opened windows: MarketCore, Execution, ControlAPI, Dashboard
echo   Stop later: scripts\stop.bat
echo ============================================================
call :log SUCCESS
echo.
echo This window can stay open. Press any key to close it.
pause >nul
exit /b 0

:fail
echo.
echo ============================================================
echo   FAILED - see messages above
echo ============================================================
echo Log: %LOG%
call :log FAILED
echo.
echo Press any key to close this window.
pause >nul
exit /b 1

:ensure_msvc
where cl >nul 2>&1
if not errorlevel 1 (
  echo [OK] cl.exe already available
  goto :eof
)
set "VSWHERE="
if exist "%SystemDrive%\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" set "VSWHERE=%SystemDrive%\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
if not defined VSWHERE (
  echo [WARN] vswhere missing
  goto :eof
)
set "VSINSTALL="
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if not defined VSINSTALL (
  echo [WARN] VS C++ tools not found
  goto :eof
)
if exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" (
  echo Loading MSVC...
  call "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" >nul
)
where cl >nul 2>&1
if errorlevel 1 (echo [WARN] cl.exe still missing) else (echo [OK] MSVC loaded)
goto :eof

:log
>>"%LOG%" echo [%DATE% %TIME%] %*
goto :eof
