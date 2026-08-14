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
echo.

if not exist "%ROOT%\apps\dashboard\package.json" (
  color 0C
  echo [KLUDA] Sis nav VS mape ^(vajag C:\VS-main ar apps\^).
  pause
  exit /b 1
)

echo [1] Apturu vecos VS / Node procesus...
taskkill /F /T /IM VS.exe >nul 2>&1
taskkill /F /T /IM VS_RESTART.exe >nul 2>&1
taskkill /F /T /IM node.exe >nul 2>&1
taskkill /F /T /IM npm.exe >nul 2>&1
taskkill /F /T /IM tsx.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2] Lejupieladeju VS.exe caur PowerShell + GitHub API...
echo     ^(nezdesu veco exe, kamer jaunais nav gatavs^)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$root='%ROOT%';" ^
  "$tmp=Join-Path $root 'VS.exe.new';" ^
  "$dst=Join-Path $root 'VS.exe';" ^
  "function Ok([string]$p){ if(!(Test-Path $p)){return $false}; $i=Get-Item $p; if($i.Length -lt 5000000){return $false}; $b=[IO.File]::ReadAllBytes($p)[0..1]; return ($b[0]-eq 0x4D -and $b[1]-eq 0x5A) };" ^
  "Remove-Item $tmp -Force -EA SilentlyContinue;" ^
  "$headers=@{ Accept='application/vnd.github.raw'; 'User-Agent'='VS-bat-bridge75a0' };" ^
  "$urls=@(" ^
  " 'https://api.github.com/repos/voldis1994/VS/contents/VS.exe?ref=main'," ^
  " 'https://raw.githubusercontent.com/voldis1994/VS/94624a2/VS.exe'," ^
  " 'https://github.com/voldis1994/VS/raw/refs/heads/main/VS.exe'" ^
  ");" ^
  "$ok=$false;" ^
  "foreach($u in $urls){" ^
  "  try {" ^
  "    Write-Host ('[..] '+$u);" ^
  "    Invoke-WebRequest -Uri $u -Headers $headers -OutFile $tmp -UseBasicParsing -TimeoutSec 600;" ^
  "    if(Ok $tmp){ Write-Host ('[OK] bytes='+(Get-Item $tmp).Length); $ok=$true; break }" ^
  "    Write-Host '[..] noraidu — nav derigs PE'; Remove-Item $tmp -Force -EA SilentlyContinue" ^
  "  } catch { Write-Host ('[WARN] '+$_.Exception.Message) }" ^
  "};" ^
  "if(-not $ok){" ^
  "  Write-Host '[..] ZIP fallback...';" ^
  "  $z=Join-Path $root 'VS.exe.zip';" ^
  "  Invoke-WebRequest -Uri 'https://codeload.github.com/voldis1994/VS/zip/refs/heads/main' -OutFile $z -UseBasicParsing -TimeoutSec 600;" ^
  "  $d=Join-Path $env:TEMP ('vs-'+[guid]::NewGuid()); New-Item -ItemType Directory -Path $d | Out-Null;" ^
  "  try {" ^
  "    Expand-Archive -LiteralPath $z -DestinationPath $d -Force;" ^
  "    $exe=Get-ChildItem $d -Recurse -Filter VS.exe | Select-Object -First 1;" ^
  "    if($exe){ Copy-Item $exe.FullName $tmp -Force }" ^
  "  } finally { Remove-Item $d -Recurse -Force -EA SilentlyContinue; Remove-Item $z -Force -EA SilentlyContinue }" ^
  "  if(Ok $tmp){ $ok=$true; Write-Host ('[OK] ZIP bytes='+(Get-Item $tmp).Length) }" ^
  "};" ^
  "if(-not $ok){ if(Ok $dst){ Write-Host '[WARN] lejupielade fail — palaižu ESOŠO VS.exe'; exit 2 }; Write-Host '[KLUDA] nav VS.exe'; exit 1 };" ^
  "Move-Item -LiteralPath $tmp -Destination $dst -Force;" ^
  "try{ Unblock-File -LiteralPath $dst }catch{};" ^
  "Write-Host '[OK] VS.exe gatavs'; exit 0"

set "FETCH=%ERRORLEVEL%"
if "%FETCH%"=="1" (
  color 0C
  echo.
  echo [KLUDA] Nevar lejupieladet VS.exe.
  echo Atver PowerShell un ielime SIENU komandu:
  echo.
  echo cd C:\VS-main
  echo irm https://raw.githubusercontent.com/voldis1994/VS/main/FIX.ps1 ^| iex
  echo.
  pause
  exit /b 1
)
if "%FETCH%"=="2" (
  echo [..] turpinu ar esošo VS.exe
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
