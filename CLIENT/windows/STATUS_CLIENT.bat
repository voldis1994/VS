@echo off
cd /d "%~dp0.."
call "%~dp0..\VERIFY_CLIENT.bat"
exit /b %ERRORLEVEL%
