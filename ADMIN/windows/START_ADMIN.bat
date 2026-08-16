@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
call "%~dp0..\START_ADMIN.bat"
exit /b %ERRORLEVEL%
