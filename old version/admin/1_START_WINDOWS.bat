@echo off
REM Preferred path ONLY — starts canonical VS ADMIN desktop
setlocal EnableExtensions
cd /d "%~dp0"
echo Redirecting to START_ADMIN.bat (ADMIN\desktop only)...
call "%~dp0START_ADMIN.bat"
exit /b %ERRORLEVEL%
