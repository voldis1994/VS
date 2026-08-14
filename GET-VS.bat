@echo off
cd /d "%~dp0"
echo Palaizu FIX.ps1 (API + SHA256)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%CD%'; irm https://raw.githubusercontent.com/voldis1994/VS/main/FIX.ps1 | iex"
if errorlevel 1 pause
