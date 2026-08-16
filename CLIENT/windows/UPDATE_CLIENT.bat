@echo off
echo UPDATE_CLIENT — re-run INSTALL_CLIENT.bat with new package
cd /d "%~dp0"
call INSTALL_CLIENT.bat
exit /b %ERRORLEVEL%
