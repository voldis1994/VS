@echo off
if not defined VCPKG_ROOT set VCPKG_ROOT=%USERPROFILE%\vcpkg
cmake --build build/windows-debug --target bench_pipeline
build\windows-debug\tests\performance\bench_pipeline.exe
exit /b %ERRORLEVEL%
