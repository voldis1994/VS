@echo off
cd /d "%~dp0"
echo Palaizu FIX.ps1 caur GitHub API (ne raw CDN)...
REM iwr+Accept raw atgriez Byte[] — NEDRIKST iex .Content. Rakstam faila un palaizam.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "Set-Location -LiteralPath '%CD%';" ^
  "$out=Join-Path (Get-Location) 'FIX.ps1';" ^
  "Write-Host '[..] lejupieladeju FIX.ps1 →' $out;" ^
  "Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Headers @{ Accept='application/vnd.github.raw'; 'User-Agent'='VS-GET'; 'Cache-Control'='no-cache' } -Uri 'https://api.github.com/repos/voldis1994/VS/contents/FIX.ps1?ref=main' -OutFile $out;" ^
  "if(-not (Test-Path -LiteralPath $out)){ throw 'FIX.ps1 download failed' };" ^
  "Write-Host '[OK] palaizu FIX.ps1';" ^
  "& $out"

if errorlevel 1 (
  color 0C
  echo [KLUDA] FIX neizdevas.
  pause
)
