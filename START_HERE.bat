@echo off
cd /d "%~dp0"
title Market Reader Launcher
echo.
echo Opening Market Reader setup window...
echo If nothing appears, right-click START_HERE.bat - Run as administrator
echo.
start "Market Reader First Run" cmd /k call "%~dp0scripts\first_run.bat"
exit /b 0
