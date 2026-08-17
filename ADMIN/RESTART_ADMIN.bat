@echo off
REM Restart only VS ADMIN (i3 stays up)
setlocal
cd /d "%~dp0"
call "%~dp0STOP_ADMIN.bat"
call "%~dp0..\START_MSI.bat"
exit /b %ERRORLEVEL%
