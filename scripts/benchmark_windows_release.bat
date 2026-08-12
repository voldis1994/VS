@echo off
REM Hot-path + load benchmarks for Windows 11 x64 / MSVC / Release only.
if not exist build\windows-release\tests\performance\bench_hot_path.exe (
    echo Build Release first: scripts\verify_windows_release.bat
    exit /b 1
)
if not exist benchmark-results mkdir benchmark-results
set OUT=benchmark-results\windows-msvc-release.txt
echo Environment: Windows 11 x64 > %OUT%
echo Compiler: MSVC >> %OUT%
echo Configuration: Release >> %OUT%
echo. >> %OUT%
build\windows-release\tests\performance\bench_hot_path.exe >> %OUT%
set MR_LOAD_DURATION_SEC=10
build\windows-release\tests\performance\bench_load.exe >> %OUT%
type %OUT%
exit /b %ERRORLEVEL%
