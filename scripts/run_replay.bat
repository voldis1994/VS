@echo off
build\windows-debug\apps\market-core\market-core.exe --mode REPLAY --replay %1
exit /b %ERRORLEVEL%
