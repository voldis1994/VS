@echo off
setlocal enabledelayedexpansion

echo ================================
echo MARKET READER - Windows Setup
echo ================================
echo.

set ERRORS=0

call :check_tool git "Git" "winget install Git.Git"
call :check_tool cmake "CMake" "winget install Kitware.CMake"
call :check_tool node "Node.js" "winget install OpenJS.NodeJS.LTS"
call :check_tool npm "npm" "echo npm comes with Node.js"
call :check_tool docker "Docker" "winget install Docker.DockerDesktop"
call :check_tool powershell "PowerShell" "echo PowerShell is built-in"

where cl >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [WARN] MSVC cl.exe not found in PATH.
    echo        Install Visual Studio 2022 Build Tools with C++ workload.
    echo        winget install Microsoft.VisualStudio.2022.BuildTools
    set /a ERRORS+=1
) else (
    echo [OK] MSVC found
)

if not defined VCPKG_ROOT (
    if exist "%USERPROFILE%\vcpkg\vcpkg.exe" (
        set VCPKG_ROOT=%USERPROFILE%\vcpkg
    ) else (
        echo Bootstrapping vcpkg...
        git clone https://github.com/microsoft/vcpkg.git "%USERPROFILE%\vcpkg"
        call "%USERPROFILE%\vcpkg\bootstrap-vcpkg.bat"
        set VCPKG_ROOT=%USERPROFILE%\vcpkg
    )
)
echo [OK] VCPKG_ROOT=%VCPKG_ROOT%

if not exist .env (
    copy .env.example .env
    echo [OK] Created .env from .env.example
) else (
    echo [OK] .env already exists - not overwritten
)

echo.
echo Installing vcpkg dependencies...
"%VCPKG_ROOT%\vcpkg.exe" install --triplet x64-windows
if %ERRORLEVEL% neq 0 set /a ERRORS+=1

echo.
echo Configuring CMake Debug...
cmake --preset windows-debug
if %ERRORLEVEL% neq 0 set /a ERRORS+=1

echo Building Debug...
cmake --build build/windows-debug --config Debug
if %ERRORLEVEL% neq 0 set /a ERRORS+=1

echo Configuring CMake Release...
cmake --preset windows-release
if %ERRORLEVEL% neq 0 set /a ERRORS+=1

echo Building Release...
cmake --build build/windows-release --config Release
if %ERRORLEVEL% neq 0 set /a ERRORS+=1

echo.
echo Installing backend dependencies...
cd apps\control-api
call npm install
if %ERRORLEVEL% neq 0 set /a ERRORS+=1
cd ..\..

echo Installing frontend dependencies...
cd apps\dashboard
call npm install
if %ERRORLEVEL% neq 0 set /a ERRORS+=1
cd ..\..

echo.
echo Starting database...
docker compose up -d postgres redis
timeout /t 5 /nobreak >nul

echo Running migrations...
cd apps\control-api
call npm run migrate
if %ERRORLEVEL% neq 0 set /a ERRORS+=1
cd ..\..

echo Running unit tests...
cd build\windows-debug
ctest --output-on-failure
if %ERRORLEVEL% neq 0 set /a ERRORS+=1
cd ..\..

echo.
if %ERRORS% equ 0 (
    echo ================================
    echo SETUP COMPLETE
    echo ================================
    echo.
    echo Start development:
    echo   scripts\run_dev.bat
    echo.
    echo Run paper trading:
    echo   scripts\run_paper.bat
    echo.
    echo Run replay:
    echo   scripts\run_replay.bat data\replay\events.mrev
    echo.
    echo Dashboard: http://localhost:5173
    echo Control API: http://localhost:3000
) else (
    echo ================================
    echo SETUP COMPLETED WITH %ERRORS% ERROR(S)
    echo ================================
    echo Review output above and fix missing prerequisites.
)

exit /b %ERRORS%

:check_tool
where %1 >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [MISSING] %2
    echo          Suggested: %3
    set /a ERRORS+=1
) else (
    echo [OK] %2
)
goto :eof
