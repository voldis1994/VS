@echo off
REM Operators: ADMIN\windows\BUILD_ADMIN.bat
setlocal EnableExtensions
cd /d "%~dp0"
call "%CD%\windows\BUILD_ADMIN.bat"
exit /b %ERRORLEVEL%
