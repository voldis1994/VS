@echo off
echo UPDATE_ADMIN — pull latest ADMIN package / re-run INSTALL_ADMIN.bat
setlocal EnableExtensions
cd /d "%~dp0.."
call "%~dp0..\INSTALL_ADMIN.bat"
exit /b %ERRORLEVEL%
