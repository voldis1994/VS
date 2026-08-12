@echo off
cd /d "%~dp0"
title MARKET READER - Launcher
echo.
echo ===============================================
echo   THIS MUST SAY: MARKET READER
echo   If you see BOSH / RUI / MISE / MGRR - WRONG FOLDER
echo ===============================================
echo.
start "MARKET READER First Run" cmd /k call "%~dp0scripts\first_run.bat"
exit /b 0
