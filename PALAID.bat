@echo off
REM Tikai palaiž ESOŠO VS.exe — neko nelejumielade
cd /d "%~dp0"
if not exist "%~dp0VS.exe" (
  echo NAV VS.exe — PowerShell Admin:
  echo   cd C:\VS-main
  echo   iex (iwr -UseBasicParsing -Headers @{Accept='application/vnd.github.raw';'User-Agent'='VS'} https://api.github.com/repos/voldis1994/VS/contents/FIX.ps1?ref=main^).Content
  pause
  exit /b 1
)
start "" "%~dp0VS.exe" "%~dp0"
start "" "http://127.0.0.1:18090"
