@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
call "%~dp0..\STATUS_ADMIN.bat"
exit /b %ERRORLEVEL%
