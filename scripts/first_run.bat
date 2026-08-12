@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0.."
set "ROOT=%CD%"
set "LOG=%ROOT%\logs\first_run.log"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs" >nul 2>&1

color 07
cls
echo ============================================================
echo   MARKET READER - FIRST RUN
echo   Repo must be: github.com/voldis1994/VS
echo   Folder: %ROOT%
echo ============================================================
echo.
echo If this title is NOT "MARKET READER" you are in the wrong project.
echo.

REM Refuse wrong projects early
if not exist "%ROOT%\apps\market-core\CMakeLists.txt" (
  color 0C
  echo [FAIL] apps\market-core not found.
  echo        You are NOT in Market Reader folder.
  echo        Download: https://github.com/voldis1994/VS/archive/refs/heads/main.zip
  goto :fail
)
if not exist "%ROOT%\apps\dashboard\package.json" (
  color 0C
  echo [FAIL] apps\dashboard not found. Wrong folder.
  goto :fail
)

call :log START
call :check_disk
if errorlevel 1 goto :fail

echo [0/9] Loading MSVC x64 toolchain...
call :ensure_msvc
if errorlevel 1 goto :fail
echo.

echo [1/9] Checking tools...
set "MISSING=0"
call :need git Git "winget install -e --id Git.Git"
call :need cmake CMake "winget install -e --id Kitware.CMake"
call :need node Node.js "winget install -e --id OpenJS.NodeJS.LTS"
call :need npm npm "Reinstall Node.js LTS"
call :need docker Docker "winget install -e --id Docker.DockerDesktop"
where cl >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [MISSING] MSVC cl.exe
  echo.
  echo RED ERROR MEANING: Visual Studio C++ tools are missing or broken.
  echo FIX:
  echo   1^) winget install -e --id Microsoft.VisualStudio.2022.BuildTools
  echo   2^) In installer select workload: Desktop development with C++
  echo   3^) Reboot PC
  echo   4^) Run START_HERE.bat again
  set "MISSING=1"
) else (
  echo [OK] MSVC cl.exe
  for /f "delims=" %%V in ('cl 2^>^&1') do (
    echo       %%V
    goto :cl_shown
  )
)
:cl_shown
if "!MISSING!"=="1" goto :fail

echo.
echo [2/9] .env ...
if not exist "%ROOT%\.env" (
  copy /Y "%ROOT%\.env.example" "%ROOT%\.env" >nul
  if errorlevel 1 goto :fail
  echo [OK] created .env
) else (
  echo [OK] .env exists ^(not overwritten^)
)

echo.
echo [3/9] vcpkg ...
REM Never trust a broken VCPKG_ROOT ^(VS BuildTools VC\vcpkg often empty^)
set "VCPKG_ROOT=%USERPROFILE%\vcpkg"
echo Using VCPKG_ROOT=%VCPKG_ROOT%

if not exist "%VCPKG_ROOT%\vcpkg.exe" (
  if not exist "%VCPKG_ROOT%\bootstrap-vcpkg.bat" (
    echo Cloning vcpkg into %VCPKG_ROOT% ...
    if exist "%VCPKG_ROOT%" rd /s /q "%VCPKG_ROOT%" 2>nul
    git clone https://github.com/microsoft/vcpkg.git "%VCPKG_ROOT%"
    if errorlevel 1 (
      color 0C
      echo [FAIL] git clone vcpkg failed. Check internet / Git.
      goto :fail
    )
  )
  echo Bootstrapping vcpkg.exe ...
  call "%VCPKG_ROOT%\bootstrap-vcpkg.bat" -disableMetrics
  if errorlevel 1 (
    color 0C
    echo ============================================================
    echo RED ERROR: bootstrap-vcpkg.bat failed / vcpkg.exe not built
    echo MEANING: C++ Build Tools cannot compile vcpkg bootstrap.
    echo FIX:
    echo   - Install VS 2022 Build Tools with "Desktop development with C++"
    echo   - Free disk space on C: ^(need 15+ GB^)
    echo   - Run this window as Administrator
    echo   - Then run START_HERE.bat again
    echo ============================================================
    goto :fail
  )
)

if not exist "%VCPKG_ROOT%\vcpkg.exe" (
  color 0C
  echo [FAIL] vcpkg.exe still missing after bootstrap: %VCPKG_ROOT%\vcpkg.exe
  echo        Same fix as above: repair VS C++ tools + free disk.
  goto :fail
)
echo [OK] vcpkg.exe found

echo Installing C++ packages ^(long step^)...
"%VCPKG_ROOT%\vcpkg.exe" install --triplet x64-windows
if errorlevel 1 (
  color 0C
  echo [FAIL] vcpkg install failed.
  echo        Often: not enough disk, antivirus lock, or broken MSVC.
  goto :fail
)
echo [OK] vcpkg packages installed

echo.
echo [4/9] CMake configure + build ...
cmake --preset windows-debug
if errorlevel 1 (
  color 0C
  echo [FAIL] cmake configure failed.
  echo        Open "x64 Native Tools Command Prompt for VS 2022" and retry.
  goto :fail
)
cmake --build build\windows-debug --config Debug
if errorlevel 1 (
  color 0C
  echo [FAIL] C++ build failed. See errors above.
  goto :fail
)
if not exist "%ROOT%\build\windows-debug\apps\market-core\market-core.exe" (
  color 0C
  echo [FAIL] market-core.exe missing after build
  goto :fail
)
echo [OK] C++ build ready

echo.
echo [5/9] npm install ...
cd /d "%ROOT%\apps\control-api"
call npm install
if errorlevel 1 (
  color 0C
  echo [FAIL] control-api npm install failed
  echo        If EPERM: close other node processes, run as Admin, retry.
  goto :fail
)
cd /d "%ROOT%\apps\dashboard"
call npm install
if errorlevel 1 (
  color 0C
  echo [FAIL] dashboard npm install failed
  goto :fail
)
cd /d "%ROOT%"
echo [OK] npm done

echo.
echo [6/9] Docker Postgres ...
docker info >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [FAIL] Docker installed but not running.
  echo        Start Docker Desktop, wait until green, retry.
  goto :fail
)
docker compose up -d postgres redis
if errorlevel 1 goto :fail
set "READY=0"
for /L %%i in (1,1,40) do (
  docker compose exec -T postgres pg_isready -U market_reader -d market_reader >nul 2>&1
  if not errorlevel 1 (
    set "READY=1"
    goto :pgok
  )
  ping -n 2 127.0.0.1 >nul
)
:pgok
if not "!READY!"=="1" (
  color 0C
  echo [FAIL] Postgres not ready
  goto :fail
)
echo [OK] Postgres ready

echo.
echo [7/9] DB migrations ...
cd /d "%ROOT%\apps\control-api"
call npm run migrate
if errorlevel 1 (
  color 0C
  echo [FAIL] migration failed. Check DB_PASSWORD in .env
  goto :fail
)
cd /d "%ROOT%"
echo [OK] migrations done

echo.
echo [8/9] Starting services ...
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
echo [9/9] Opening dashboard ...
start http://localhost:5173

color 0A
echo.
echo ============================================================
echo   MARKET READER SETUP COMPLETE
echo   Dashboard: http://localhost:5173
echo   API:       http://localhost:3000/health
echo ============================================================
call :log SUCCESS
echo.
echo Press any key to close this window.
pause >nul
exit /b 0

:fail
color 0C
echo.
echo ============================================================
echo   MARKET READER FIRST RUN FAILED
echo   Read the RED lines above.
echo   Log: %LOG%
echo ============================================================
call :log FAILED
echo.
echo Press any key to close this window.
pause >nul
exit /b 1

:need
where %~1 >nul 2>&1
if errorlevel 1 (
  echo [MISSING] %~2
  echo           Install: %~3
  set "MISSING=1"
) else (
  echo [OK] %~2
)
goto :eof

:ensure_msvc
where cl >nul 2>&1
if not errorlevel 1 (
  echo [OK] cl.exe already in PATH
  exit /b 0
)
set "VSWHERE=%SystemDrive%\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "!VSWHERE!" (
  color 0C
  echo [FAIL] vswhere.exe not found.
  echo        Visual Studio / Build Tools not installed correctly.
  echo        FIX: winget install -e --id Microsoft.VisualStudio.2022.BuildTools
  echo             Select: Desktop development with C++
  exit /b 1
)
set "VSINSTALL="
for /f "usebackq delims=" %%i in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if not defined VSINSTALL (
  color 0C
  echo [FAIL] MSVC toolset not found ^(MSVCNotInstalled^).
  echo        Visual Studio is installed but C++ workload is missing/broken.
  echo        FIX:
  echo          Open Visual Studio Installer - Modify
  echo          Enable workload: Desktop development with C++
  echo          Include MSVC v143 and Windows 10/11 SDK
  exit /b 1
)
if not exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" (
  color 0C
  echo [FAIL] vcvars64.bat missing in !VSINSTALL!
  echo        Repair Visual Studio Build Tools.
  exit /b 1
)
echo Loading: !VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat
call "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 (
  color 0C
  echo [FAIL] vcvars64.bat returned error. Toolchain invalid state.
  exit /b 1
)
where cl >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [FAIL] cl.exe still missing after vcvars64.
  echo        Repair VS Installer - C++ tools.
  exit /b 1
)
echo [OK] MSVC loaded from !VSINSTALL!
exit /b 0

:check_disk
set "FREE_GB="
for /f "tokens=3" %%a in ('dir /-c "%SystemDrive%\" 2^>nul ^| findstr /C:"bytes free"') do set "FREE=%%a"
REM Fallback using powershell
for /f %%A in ('powershell -NoProfile -Command "(Get-PSDrive -Name $env:SystemDrive[0]).Free/1GB -as [int]"') do set "FREE_GB=%%A"
if not defined FREE_GB (
  echo [WARN] Could not read free disk space
  exit /b 0
)
echo Free space on %SystemDrive%: !FREE_GB! GB
if !FREE_GB! LSS 15 (
  color 0C
  echo [FAIL] Not enough disk space.
  echo        Need at least ~15 GB free on %SystemDrive% for vcpkg + C++ build.
  echo        Free space, then run again.
  exit /b 1
)
echo [OK] disk space
exit /b 0

:log
>>"%LOG%" echo [%DATE% %TIME%] %*
goto :eof
