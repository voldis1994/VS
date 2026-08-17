@echo off
REM Internal helper — operators use START_MSI.bat
setlocal
cd /d "%~dp0\.."
call "%~dp0..\START_MSI.bat"
exit /b %ERRORLEVEL%
