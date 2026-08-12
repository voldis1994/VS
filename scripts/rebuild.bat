@echo off
if exist build rmdir /s /q build
call scripts\build.bat
exit /b %ERRORLEVEL%
