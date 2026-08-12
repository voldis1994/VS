@echo off
setlocal enabledelayedexpansion

echo ========================================
echo Windows 11 x64 MSVC Release Verification
echo ========================================

where cl >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [FAIL] MSVC cl.exe not found. Open "x64 Native Tools Command Prompt for VS".
    exit /b 1
)

if not defined VCPKG_ROOT (
    if exist "%USERPROFILE%\vcpkg\vcpkg.exe" set VCPKG_ROOT=%USERPROFILE%\vcpkg
)
if not defined VCPKG_ROOT (
    echo [FAIL] VCPKG_ROOT not set
    exit /b 1
)

echo Compiler:
cl 2>&1 | findstr /i "Version"

echo.
echo Cleaning previous build artifacts...
if exist build\windows-release rmdir /s /q build\windows-release
if exist build\windows-debug rmdir /s /q build\windows-debug

echo.
echo Configuring Release (MSVC x64 + vcpkg)...
cmake --preset windows-release
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo Building Release...
cmake --build build/windows-release --config Release -j
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo Configuring Debug...
cmake --preset windows-debug
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo Building Debug...
cmake --build build/windows-debug --config Debug -j
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo.
echo Running Release CTest...
cd build\windows-release
ctest -C Release --output-on-failure
set TEST_RC=%ERRORLEVEL%
cd ..\..
if %TEST_RC% neq 0 exit /b %TEST_RC%

echo.
echo Running hot-path Release benchmark...
set OUT=benchmark-results\windows-msvc-release.txt
if not exist benchmark-results mkdir benchmark-results
(
  echo Environment: Windows 11 x64
  echo Compiler: MSVC
  echo Configuration: Release
  echo Timestamp: %DATE% %TIME%
  echo.
) > %OUT%

build\windows-release\tests\performance\bench_hot_path.exe >> %OUT%
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo.
echo Running load stress test (10s per target)...
set MR_LOAD_DURATION_SEC=10
build\windows-release\tests\performance\bench_load.exe >> %OUT%
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo.
echo Results written to %OUT%
type %OUT%
echo.
echo ========================================
echo WINDOWS MSVC RELEASE VERIFICATION DONE
echo ========================================
exit /b 0
