@echo off
if not defined VCPKG_ROOT set VCPKG_ROOT=%USERPROFILE%\vcpkg
cmake --preset windows-debug
cmake --build build/windows-debug --config Debug
cd build\windows-debug
ctest --output-on-failure
exit /b %ERRORLEVEL%
