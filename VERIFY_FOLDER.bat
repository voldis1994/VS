@echo off
cd /d "%~dp0"
color 0A
echo.
echo ===============================================
echo   FOLDER CHECK
echo ===============================================
echo Folder: %CD%
echo.
if exist "%~dp0apps\market-core\CMakeLists.txt" (echo [OK] apps\market-core) else (echo [FAIL] apps\market-core MISSING)
if exist "%~dp0apps\dashboard\package.json" (echo [OK] apps\dashboard) else (echo [FAIL] apps\dashboard MISSING)
if exist "%~dp0scripts\first_run.bat" (echo [OK] scripts\first_run.bat) else (echo [FAIL] scripts\first_run.bat MISSING)
if exist "%~dp0CMakeLists.txt" (echo [OK] CMakeLists.txt) else (echo [FAIL] CMakeLists.txt MISSING)
echo.
echo Opening first_run.bat header:
echo -----------------------------------------------
powershell -NoProfile -Command "Get-Content -TotalCount 15 '%~dp0scripts\first_run.bat'"
echo -----------------------------------------------
echo.
echo If header does NOT contain MARKET READER - you opened the wrong ZIP.
echo.
pause
