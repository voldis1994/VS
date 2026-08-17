@echo off
REM Required path: ADMIN\windows\INSTALL_ADMIN.bat
setlocal EnableExtensions
cd /d "%~dp0.."
call "%CD%\INSTALL_ADMIN.bat"
exit /b %ERRORLEVEL%
