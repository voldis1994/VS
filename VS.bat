@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "ROOT=%CD%"
title VS - palaisana (NEAIZVER SO LOGU)
color 0A

echo.
echo ============================================================
echo   VS  KOMANDU PANELIS  /  bridge75a0
echo ============================================================
echo   Mape: %ROOT%
echo   Update: API + SHA256  (ne "MINSIZE CDN" slazds)
echo.

if not exist "%ROOT%\apps\dashboard\package.json" (
  color 0C
  echo [KLUDA] Sis nav VS mape ^(vajag C:\VS-main ar apps\^).
  pause
  exit /b 1
)

echo [1] Apturu vecos VS / Node procesus (VS.exe FAILU NEZDESU)...
taskkill /F /T /IM VS.exe >nul 2>&1
taskkill /F /T /IM VS_RESTART.exe >nul 2>&1
taskkill /F /T /IM node.exe >nul 2>&1
taskkill /F /T /IM npm.exe >nul 2>&1
taskkill /F /T /IM tsx.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2] Lejupielade + validacija (Fetch-VSExe.ps1 via GitHub API)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$root='%ROOT%';" ^
  "$dir=Join-Path $root 'tools\windows';" ^
  "$ps1=Join-Path $dir 'Fetch-VSExe.ps1';" ^
  "New-Item -ItemType Directory -Force -Path $dir | Out-Null;" ^
  "Write-Host '[..] atjauninu Fetch-VSExe.ps1 caur api.github.com';" ^
  "Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Headers @{ Accept='application/vnd.github.raw'; 'User-Agent'='VS-bat'; 'Cache-Control'='no-cache' } -Uri 'https://api.github.com/repos/voldis1994/VS/contents/tools/windows/Fetch-VSExe.ps1?ref=main' -OutFile $ps1;" ^
  "& $ps1 -Root $root; exit $LASTEXITCODE"

if errorlevel 1 (
  color 0C
  echo.
  echo [KLUDA] Update neizdevas — skaties iemeslu augstak.
  echo.
  echo Plan B (PowerShell Admin) — lejupielade FAILA, ne iex:
  echo   cd C:\VS-main
  echo   iwr -UseBasicParsing -Headers @{Accept='application/vnd.github.raw';'User-Agent'='VS'} -Uri https://api.github.com/repos/voldis1994/VS/contents/FIX.ps1?ref=main -OutFile FIX.ps1
  echo   powershell -NoProfile -ExecutionPolicy Bypass -File .\FIX.ps1
  echo.
  if exist "%ROOT%\VS.exe" (
    echo [..] paliek iepriekseja VS.exe — megina palaist to.
    goto launch
  )
  pause
  exit /b 1
)

:launch
if not exist "%ROOT%\VS.exe" (
  color 0C
  echo [KLUDA] VS.exe nav.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   PANELIS:  http://127.0.0.1:18090
echo   JA REDZI LAUNCHER = bridge75a0  — ir jaunais
echo ============================================================
echo.

start "" "%ROOT%\VS.exe" "%ROOT%"
timeout /t 4 /nobreak >nul

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --start-fullscreen --app=http://127.0.0.1:18090
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --start-fullscreen --app=http://127.0.0.1:18090
) else (
  start "" "http://127.0.0.1:18090"
)

echo [OK] palaists. NEAIZVER so logu.
pause
exit /b 0
