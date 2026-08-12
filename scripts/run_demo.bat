@echo off
set OPERATING_MODE=DEMO
build\windows-debug\apps\market-core\market-core.exe --mode DEMO
exit /b %ERRORLEVEL%
