@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Re-launch from %%TEMP%% so git pull can update VS.bat on disk.
if /I "%~1"=="_INNER" (
  set "ROOT=%~2"
  if not defined ROOT set "ROOT=%CD%"
  cd /d "!ROOT!"
  goto :body
)

cd /d "%~dp0"
set "ROOT=%CD%"
copy /Y "%~f0" "%TEMP%\VS_launch.bat" >nul
call "%TEMP%\VS_launch.bat" _INNER "%ROOT%"
exit /b %ERRORLEVEL%

:body
title VS - palaisana (NEAIZVER SO LOGU)
color 0A
cd /d "%ROOT%"

echo.
echo ============================================================
echo   VS  -  VIENS PALAISANAS FAILS
echo   Aptur veco  ^|  GitHub main  ^|  Palais sistemu  ^|  Klienta tunelis
echo ============================================================
echo   Mape: %ROOT%
echo.

if not exist "%ROOT%\apps\dashboard\package.json" (
  color 0C
  echo [KLUDA] Sis nav VS mape. Ieliec VS.bat ieksha GitHub VS mapes.
  echo         Jabut mapei: apps\dashboard
  pause
  exit /b 1
)
if not exist "%ROOT%\apps\market-core\CMakeLists.txt" (
  color 0C
  echo [KLUDA] apps\market-core nav. Lejupielade:
  echo         https://github.com/voldis1994/VS
  pause
  exit /b 1
)

echo [1/5] Apturu vecos procesus...
taskkill /F /FI "WINDOWTITLE eq MR-*" >nul 2>&1
taskkill /F /IM market-core.exe >nul 2>&1
taskkill /F /IM execution-service.exe >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":3000 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":5173 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":5174 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":5175 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
echo [OK]
echo.

if /I "%~3"=="SKIPPULL" goto :after_pull

echo [2/5] Lejupieladeju jaunako GitHub main...
where git >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [KLUDA] Git nav instalets.
  echo         winget install -e --id Git.Git
  pause
  exit /b 1
)
if not exist "%ROOT%\.git" (
  echo [WARN] Sis mape nav git clone - izlaidisu git pull.
  echo        Ieteikums: git clone https://github.com/voldis1994/VS.git
  goto :after_pull
)
cd /d "%ROOT%"
git fetch origin main
if errorlevel 1 (
  color 0C
  echo [KLUDA] git fetch neizdevas. Parbaudi internetu.
  pause
  exit /b 1
)
git checkout -f main
git reset --hard origin/main
if errorlevel 1 (
  color 0C
  echo [KLUDA] git reset neizdevas.
  pause
  exit /b 1
)
for /f "delims=" %%H in ('git rev-parse --short HEAD') do echo [OK] main  %%H
echo.

REM Continue with the freshly pulled VS.bat so launch logic stays current.
if exist "%ROOT%\VS.bat" (
  copy /Y "%ROOT%\VS.bat" "%TEMP%\VS_launch.bat" >nul
  call "%TEMP%\VS_launch.bat" _INNER "%ROOT%" SKIPPULL
  exit /b %ERRORLEVEL%
)

:after_pull
echo [3/5] Datubaze + npm...
where node >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [KLUDA] Node.js nav. winget install -e --id OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [KLUDA] Docker Desktop NAV ieslegts. Iesledz Docker un palaid VS.bat velreiz.
  pause
  exit /b 1
)

if not exist "%ROOT%\.env" (
  copy /Y "%ROOT%\.env.example" "%ROOT%\.env" >nul
  echo [OK] izveidots .env
)
call :upsert_env OPERATING_MODE LIVE
call :upsert_env LIVE_TRADING_ENABLED true
call :upsert_env MARKET_CORE_BRIDGE 1

docker start market-reader-postgres >nul 2>&1
docker start market-reader-redis >nul 2>&1
docker compose up -d postgres redis
if errorlevel 1 docker compose up -d postgres redis
ping -n 5 127.0.0.1 >nul

cd /d "%ROOT%\apps\control-api"
call npm install
if errorlevel 1 (
  color 0C
  echo [KLUDA] control-api npm install
  pause
  exit /b 1
)
call npm run migrate
if errorlevel 1 (
  color 0C
  echo [KLUDA] DB migrate. Parbaudi .env DB_PASSWORD un Docker.
  pause
  exit /b 1
)
cd /d "%ROOT%\apps\dashboard"
call npm install
if errorlevel 1 (
  color 0C
  echo [KLUDA] dashboard npm install
  pause
  exit /b 1
)
echo [..] buveju client panel (bez Vite host check)...
call npx --yes vite build --config vite.client.config.ts
if errorlevel 1 (
  color 0C
  echo [KLUDA] client panel vite build
  pause
  exit /b 1
)
cd /d "%ROOT%"
echo [OK] API + dashboard + client build
echo.

echo [4/5] Palaisu sistemu...
set "LIVE_TRADING_ENABLED=true"
set "OPERATING_MODE=LIVE"
set "MARKET_CORE_BRIDGE=1"

set "MC=%ROOT%\build\windows-debug\apps\market-core\market-core.exe"
if not exist "%MC%" set "MC=%ROOT%\build\windows-release\apps\market-core\market-core.exe"
if not exist "%MC%" (
  echo [..] market-core.exe nav - meginu C++ build...
  call :try_build_core
  set "MC=%ROOT%\build\windows-debug\apps\market-core\market-core.exe"
  if not exist "!MC!" set "MC=%ROOT%\build\windows-release\apps\market-core\market-core.exe"
)

if exist "%MC%" (
  start "MR-MarketCore" /D "%ROOT%" cmd /k set MARKET_CORE_BRIDGE=1^& set OPERATING_MODE=LIVE^& set LIVE_TRADING_ENABLED=true^& "%MC%" --mode LIVE --bridge
  echo [OK] market-core LIVE --bridge
) else (
  echo [WARN] market-core.exe nav. Client Panel startes, bet live setup vajag C++ build.
  echo        cmake --preset windows-debug
  echo        cmake --build build\windows-debug --config Debug
)

set "EX=%ROOT%\build\windows-debug\apps\execution-service\execution-service.exe"
if not exist "%EX%" set "EX=%ROOT%\build\windows-release\apps\execution-service\execution-service.exe"
if exist "%EX%" start "MR-Execution" /D "%ROOT%" cmd /k "%EX%" --mode LIVE

start "MR-ControlAPI" /D "%ROOT%\apps\control-api" cmd /k set CLIENT_PANEL_DIST=%ROOT%\apps\dashboard\dist-client^& npm run dev
echo [..] gaidu API + client panel :3000 ...
call :wait_port 3000 40
start "MR-Dashboard" /D "%ROOT%\apps\dashboard" cmd /k npm run dev
start http://localhost:5173/clients
echo [OK] admin  http://localhost:5173/
echo [OK] klientu kodi: http://localhost:5173/clients
echo [OK] klienta tunelis iet uz API :3000 (NE Vite)
echo.

echo [5/5] Klienta tunelis - SUTI SO SAITI KLIENTAM
echo.
echo ============================================================
echo   NEAIZVER SO LOGU
echo   Zemak paradisies:  https://....trycloudflare.com
echo   To + access code (Clients lapa)  -^>  klientam
echo ============================================================
echo.

where cloudflared >nul 2>&1
if not errorlevel 1 (
  cloudflared tunnel --url http://127.0.0.1:3000
  goto :eof
)
where npm >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [KLUDA] Nav cloudflared un nav npm - tuneli nevar atvert.
  pause
  exit /b 1
)
npx --yes cloudflared tunnel --url http://127.0.0.1:3000
exit /b %ERRORLEVEL%

:wait_port
set "_PORT=%~1"
set "_MAX=%~2"
if not defined _MAX set "_MAX=30"
set /a _N=0
:wait_port_loop
netstat -ano 2>nul | findstr ":%_PORT% " | findstr LISTENING >nul
if not errorlevel 1 exit /b 0
set /a _N+=1
if !_N! GEQ !_MAX! (
  echo [WARN] ports :%_PORT% vel nav LISTENING - turpinu
  exit /b 0
)
ping -n 2 127.0.0.1 >nul
goto :wait_port_loop

:upsert_env
REM %1=KEY  %2=VALUE
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='!ROOT!\.env'; $k='%~1'; $v='%~2'; if (-not (Test-Path -LiteralPath $p)) { Set-Content -LiteralPath $p -Value ($k+'='+$v) ; exit 0 }; $c=Get-Content -LiteralPath $p -Raw; if ($null -eq $c) { $c='' }; if ($c -match ('(?m)^'+[regex]::Escape($k)+'=')) { $c=[regex]::Replace($c,('(?m)^'+[regex]::Escape($k)+'=.*'),($k+'='+$v)) } else { if ($c.Length -gt 0 -and -not $c.EndsWith(\"`n\")) { $c+=\"`r`n\" }; $c+=($k+'='+$v+\"`r`n\") }; Set-Content -LiteralPath $p -Value $c -NoNewline"
exit /b 0

:try_build_core
where cmake >nul 2>&1
if errorlevel 1 (
  echo [WARN] CMake nav PATH - izlaidisu C++ build.
  exit /b 1
)
set "VSWHERE=%SystemDrive%\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "!VSWHERE!" (
  set "VSINSTALL="
  for /f "usebackq delims=" %%i in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
  if defined VSINSTALL if exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" (
    call "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
  )
)
if not defined VCPKG_ROOT if exist "%USERPROFILE%\vcpkg\vcpkg.exe" set "VCPKG_ROOT=%USERPROFILE%\vcpkg"
cd /d "%ROOT%"
cmake --preset windows-debug -DMR_BUILD_BENCHMARKS=OFF
if errorlevel 1 (
  echo [WARN] cmake configure neizdevas
  exit /b 1
)
cmake --build build\windows-debug --config Debug --target market-core
exit /b %ERRORLEVEL%
