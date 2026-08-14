@echo off
REM Tikai palaiž ESOŠO VS.exe — neko nelejumielade
cd /d "%~dp0"
if not exist "%~dp0VS.exe" (
  echo NAV VS.exe — palaid PowerShell:
  echo   irm https://raw.githubusercontent.com/voldis1994/VS/main/FIX.ps1 ^| iex
  pause
  exit /b 1
)
start "" "%~dp0VS.exe" "%~dp0"
start "" "http://127.0.0.1:18090"
