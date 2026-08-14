@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "ROOT=%CD%"
title VS - palaisana (NEAIZVER SO LOGU)
color 0A

echo.
echo ============================================================
echo   VS  KOMANDU PANELIS
echo ============================================================
echo   Mape: %ROOT%
echo.

if not exist "%ROOT%\apps\dashboard\package.json" (
  color 0C
  echo [KLUDA] Sis nav VS mape.
  pause
  exit /b 1
)

echo [1] Apturu VISU kas tureja veco VS.exe / Node...
taskkill /F /T /IM VS.exe >nul 2>&1
taskkill /F /T /IM VS_RESTART.exe >nul 2>&1
taskkill /F /T /IM node.exe >nul 2>&1
taskkill /F /T /IM npm.exe >nul 2>&1
taskkill /F /T /IM tsx.exe >nul 2>&1
timeout /t 3 /nobreak >nul

REM Nezdes VS.exe PIRMS veiksmigas lejupielades — citadi paliek bez exe.
set "KILLTRY=0"
:kill_loop
set /a KILLTRY+=1
taskkill /F /T /IM VS.exe >nul 2>&1
if !KILLTRY! LSS 8 (
  timeout /t 1 /nobreak >nul
  goto kill_loop
)
echo [OK] VS.exe procesi aptureti

echo [2] Lejupieladeju JAUNO VS.exe no GitHub...
del /f /q "%ROOT%\VS.exe.new" >nul 2>&1
del /f /q "%ROOT%\VS.exe.zip" >nul 2>&1
set "OKEXE=0"
REM 5 MB = atmet HTML kludas lapas; neatsakam CDN, ja bytes nedaudz mazaks par jaunako build
set "MINSIZE=5000000"

for %%U in (
  "https://github.com/voldis1994/VS/raw/refs/heads/main/VS.exe"
  "https://github.com/voldis1994/VS/raw/main/VS.exe"
  "https://raw.githubusercontent.com/voldis1994/VS/main/VS.exe"
  "https://raw.githubusercontent.com/voldis1994/VS/refs/heads/main/VS.exe"
) do (
  if not "!OKEXE!"=="1" (
    echo [..] %%~U
    del /f /q "%ROOT%\VS.exe.new" >nul 2>&1
    curl.exe -fL --retry 5 --retry-delay 2 --connect-timeout 20 --max-time 600 -A "VS-bat" -H "Accept: application/octet-stream" -o "%ROOT%\VS.exe.new" "%%~U"
    call :check_exe "%ROOT%\VS.exe.new"
  )
)

REM Fallback: izvelk VS.exe no GitHub ZIP (ja raw CDN dod HTML / tuksu)
if not "!OKEXE!"=="1" (
  echo [..] ZIP fallback — https://codeload.github.com/voldis1994/VS/zip/refs/heads/main
  curl.exe -fL --retry 5 --retry-delay 2 --connect-timeout 20 --max-time 600 -A "VS-bat" -o "%ROOT%\VS.exe.zip" "https://codeload.github.com/voldis1994/VS/zip/refs/heads/main"
  if exist "%ROOT%\VS.exe.zip" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$z='%ROOT%\VS.exe.zip'; $d=Join-Path $env:TEMP ('vs-zip-'+[guid]::NewGuid().ToString());" ^
      "New-Item -ItemType Directory -Force -Path $d | Out-Null;" ^
      "try { Expand-Archive -LiteralPath $z -DestinationPath $d -Force;" ^
      "  $exe=Get-ChildItem -LiteralPath $d -Recurse -Filter 'VS.exe' | Select-Object -First 1;" ^
      "  if ($exe) { Copy-Item -LiteralPath $exe.FullName -Destination '%ROOT%\VS.exe.new' -Force; exit 0 } else { exit 2 }" ^
      "} catch { exit 1 } finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }"
    call :check_exe "%ROOT%\VS.exe.new"
  )
)

if not "!OKEXE!"=="1" (
  color 0C
  echo [KLUDA] VS.exe lejupielade FAIL. VECU exe NEPARRAKSTIJU.
  if exist "%ROOT%\VS.exe" (
    echo [..] paliek esošais VS.exe — megina palaist to.
    goto launch_existing
  )
  echo [KLUDA] VS.exe nav — parbaudi internetu / firewall un megini velreiz.
  pause
  exit /b 1
)

del /f /q "%ROOT%\VS.exe" >nul 2>&1
move /Y "%ROOT%\VS.exe.new" "%ROOT%\VS.exe" >nul
if not exist "%ROOT%\VS.exe" (
  color 0C
  echo [KLUDA] move uz VS.exe neizdevas.
  pause
  exit /b 1
)
for %%A in ("%ROOT%\VS.exe") do echo [OK] jaunais VS.exe uzlikts — %%~zA bytes
del /f /q "%ROOT%\VS.exe.zip" >nul 2>&1
del /f /q "%ROOT%\VS.exe.new" >nul 2>&1

:launch_existing
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Unblock-File -LiteralPath '%ROOT%\VS.exe' } catch {}" >nul 2>&1

echo.
echo ============================================================
echo   PANELIS PILNEKRANA:  http://127.0.0.1:18090
echo   Kartina LAUNCHER = bridge75a0
echo   Spied PILNEKRANS panelī, ja Chrome neatveras fullscreen.
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

echo [OK] palaisa. NEAIZVER so logu lidz panelis radaa LAUNCHER=bridge75a0.
echo.
pause
exit /b 0

:check_exe
set "CAND=%~1"
if not exist "%CAND%" goto :eof
for %%A in ("%CAND%") do (
  echo      bytes=%%~zA  (vajag >= !MINSIZE! + MZ)
  if %%~zA LSS !MINSIZE! goto :eof
)
REM PE/MZ header — atmet HTML error pages
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$b=Get-Content -LiteralPath '%CAND%' -Encoding Byte -TotalCount 2 -ErrorAction SilentlyContinue;" ^
  "if ($b -and $b.Length -ge 2 -and $b[0]-eq 0x4D -and $b[1]-eq 0x5A) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo      [..] nav Windows exe (MZ) — noraidu
  del /f /q "%CAND%" >nul 2>&1
  goto :eof
)
set "OKEXE=1"
goto :eof
