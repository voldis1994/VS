@echo off
cd /d "%~dp0"
echo Palaizu FIX.ps1 caur GitHub API (ne raw CDN)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%CD%'; iex (iwr -UseBasicParsing -Headers @{Accept='application/vnd.github.raw'; 'User-Agent'='VS'} -Uri 'https://api.github.com/repos/voldis1994/VS/contents/FIX.ps1?ref=main').Content"
if errorlevel 1 pause
