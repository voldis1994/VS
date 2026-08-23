@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "ROOT=%CD%"

echo.
echo ============================================================
echo   VS DuckDNS SETUP  (vs-system.duckdns.org)
echo ============================================================
echo.

if not exist "%ROOT%\.env" (
  if exist "%ROOT%\.env.example" copy /Y "%ROOT%\.env.example" "%ROOT%\.env" >nul
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\tools\setup-duckdns.ps1" -Root "%ROOT%"
if errorlevel 1 (
  color 0C
  pause
  exit /b 1
)

echo Vai palaist VS-DUCKDNS.bat tagad? [J/N]
choice /C JN /N /M ">"
if errorlevel 2 exit /b 0
if errorlevel 1 call "%ROOT%\VS-DUCKDNS.bat"
exit /b %ERRORLEVEL%
