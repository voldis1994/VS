@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
echo Starting VS CLIENT (opens client panel if packaged)
if exist "%~dp0..\START_CLIENT.bat" call "%~dp0..\START_CLIENT.bat" & exit /b %ERRORLEVEL%
if exist "%~dp0..\app\start.bat" call "%~dp0..\app\start.bat" & exit /b %ERRORLEVEL%
echo [CONFIG_REQUIRED] CLIENT app binary/start script not packaged yet — use VERIFY_CLIENT.bat
exit /b 2
