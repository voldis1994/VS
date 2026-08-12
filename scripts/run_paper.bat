@echo off
set OPERATING_MODE=PAPER
build\windows-debug\apps\market-core\market-core.exe --mode PAPER
build\windows-debug\apps\execution-service\execution-service.exe --mode PAPER
exit /b %ERRORLEVEL%
