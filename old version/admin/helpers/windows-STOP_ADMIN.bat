@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
call "%~dp0..\STOP_ADMIN.bat"
exit /b %ERRORLEVEL%
