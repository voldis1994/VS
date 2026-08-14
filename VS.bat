@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Always run the GitHub main launcher so a stale VS.bat on disk cannot
REM still tunnel Cloudflare into Vite (allowedHosts 403).
if /I "%~1"=="_INNER" (
  set "ROOT=%~2"
  if not defined ROOT set "ROOT=%CD%"
  cd /d "!ROOT!"
  goto :body
)

cd /d "%~dp0"
set "ROOT=%CD%"
echo [0/5] Nemu jaunako VS.bat no GitHub...
curl.exe -fsSL -o "%TEMP%\VS_from_github.bat" "https://raw.githubusercontent.com/voldis1994/VS/main/VS.bat"
if exist "%TEMP%\VS_from_github.bat" (
  call "%TEMP%\VS_from_github.bat" _INNER "%ROOT%"
  exit /b %ERRORLEVEL%
)
echo [WARN] GitHub bat neizdevas lejupieladet - turpinu ar lokalo.
call "%~f0" _INNER "%ROOT%"
exit /b %ERRORLEVEL%

:body
title VS - palaisana (NEAIZVER SO LOGU)
color 0A
cd /d "%ROOT%"

echo.
echo ============================================================
echo   VS  -  KLIENTA PANELIS CAUR :18080  (NE VITE)
echo ============================================================
echo   Mape: %ROOT%
echo.

if not exist "%ROOT%\apps\dashboard\package.json" (
  color 0C
  echo [KLUDA] Sis nav VS mape. https://github.com/voldis1994/VS
  pause
  exit /b 1
)

echo [1/5] Apturu vecos procesus + Vite + veco API...
taskkill /F /FI "WINDOWTITLE eq MR-*" >nul 2>&1
taskkill /F /IM market-core.exe >nul 2>&1
taskkill /F /IM execution-service.exe >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'vite' -or $_.CommandLine -match 'apps\\control-api' -or $_.CommandLine -match 'tsx watch' -or $_.CommandLine -match 'client-public') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":3000 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":5173 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":5174 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":5175 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":18080 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
echo [OK]
echo.

echo [2/5] Lejupieladeju jaunako GitHub main...
where git >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [KLUDA] Git nav. winget install -e --id Git.Git
  pause
  exit /b 1
)
if not exist "%ROOT%\.git" (
  color 0C
  echo [KLUDA] nav git clone - nevar uzlikt jaunako main.
  echo         Klone https://github.com/voldis1994/VS
  pause
  exit /b 1
)
cd /d "%ROOT%"
git fetch origin main
if errorlevel 1 (
  color 0C
  echo [KLUDA] git fetch neizdevas. NE turpinu ar veco kodu. Parbaudi internetu un palaid VS.bat velreiz.
  pause
  exit /b 1
)
git checkout -f main
git reset --hard origin/main
if errorlevel 1 (
  color 0C
  echo [KLUDA] git reset neizdevas. NE turpinu ar veco disku.
  pause
  exit /b 1
)
for /f "delims=" %%H in ('git rev-parse --short HEAD') do set "BUILD_SHA=%%H"
if not defined BUILD_SHA set "BUILD_SHA=unknown"
echo.
echo ============================================================
echo   BUILD  !BUILD_SHA!
echo   ENTRY  Node robotDesk  ^(NE C++ market-core lemumi^)
echo   SL     Capital min + 10%%
echo   TREND  3 minutes
echo ============================================================
echo.
if not exist "%ROOT%\apps\dashboard\package.json" (
  color 0C
  echo [KLUDA] Trukst projekta failu pec git. https://github.com/voldis1994/VS
  pause
  exit /b 1
)
echo.

echo [3/5] Datubaze + npm + client build...
where node >nul 2>&1
if errorlevel 1 (
  color 0C
  echo [KLUDA] Node.js nav.
  pause
  exit /b 1
)
call :ensure_docker
if errorlevel 1 (
  color 0C
  pause
  exit /b 1
)

if not exist "%ROOT%\.env" (
  copy /Y "%ROOT%\.env.example" "%ROOT%\.env" >nul
)
call :upsert_env OPERATING_MODE LIVE
call :upsert_env LIVE_TRADING_ENABLED true
call :upsert_env MARKET_CORE_BRIDGE 1
if defined BUILD_SHA call :upsert_env BUILD_SHA !BUILD_SHA!

docker start market-reader-postgres >nul 2>&1
docker start market-reader-redis >nul 2>&1
docker compose up -d postgres redis
if errorlevel 1 docker-compose up -d postgres redis
if errorlevel 1 (
  docker inspect -f "{{.State.Running}}" market-reader-postgres 2>nul | findstr /I "true" >nul
  if errorlevel 1 (
    color 0C
    echo [KLUDA] postgres/redis nestarteja. Atver Docker Desktop - Containers.
    docker compose ps
    pause
    exit /b 1
  )
  echo [WARN] compose kluda, bet postgres jau darbojas - turpinu.
)
ping -n 5 127.0.0.1 >nul

set "npm_config_registry=https://registry.npmjs.org/"
set "npm_config_always_auth=false"
set "npm_config_//registry.npmjs.org/:_authToken="

cd /d "%ROOT%\apps\control-api"
call npm install --registry https://registry.npmjs.org/ --userconfig "%ROOT%\.npmrc"
if errorlevel 1 (
  color 0C
  echo [KLUDA] control-api npm install
  pause
  exit /b 1
)
call npm run migrate
if errorlevel 1 (
  color 0C
  echo [KLUDA] DB migrate
  pause
  exit /b 1
)
cd /d "%ROOT%\apps\dashboard"
call npm install --registry https://registry.npmjs.org/ --userconfig "%ROOT%\.npmrc"
if errorlevel 1 (
  color 0C
  echo [KLUDA] dashboard npm install
  pause
  exit /b 1
)
call npx --yes vite build --config vite.client.config.ts
if errorlevel 1 (
  color 0C
  echo [KLUDA] client panel build
  pause
  exit /b 1
)
cd /d "%ROOT%"
echo [OK]
echo.

echo [4/5] Palaisu API + publisko paneli :18080 ...
set "LIVE_TRADING_ENABLED=true"
set "OPERATING_MODE=LIVE"
set "MARKET_CORE_BRIDGE=1"
set "CLIENT_PANEL_DIST=%ROOT%\apps\dashboard\dist-client"
set "CLIENT_DIST=%ROOT%\apps\dashboard\dist-client"
set "CLIENT_PUBLIC_PORT=18080"
if not defined BUILD_SHA (
  for /f "delims=" %%H in ('git rev-parse --short HEAD') do set "BUILD_SHA=%%H"
)

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
  echo [OK] market-core
) else (
  echo [WARN] market-core.exe nav
)

set "EX=%ROOT%\build\windows-debug\apps\execution-service\execution-service.exe"
if not exist "%EX%" set "EX=%ROOT%\build\windows-release\apps\execution-service\execution-service.exe"
if exist "%EX%" start "MR-Execution" /D "%ROOT%" cmd /k "%EX%" --mode LIVE

start "MR-ControlAPI" /D "%ROOT%\apps\control-api" cmd /k set BUILD_SHA=!BUILD_SHA!^& set CLIENT_PANEL_DIST=%ROOT%\apps\dashboard\dist-client^& npm run dev
echo [..] gaidu API :3000 ...
call :wait_port 3000 40

if exist "%ROOT%\tools\client-public.mjs" (
  start "MR-ClientPublic" /D "%ROOT%" cmd /k set CLIENT_PUBLIC_PORT=18080^& set CLIENT_DIST=%ROOT%\apps\dashboard\dist-client^& node tools\client-public.mjs
) else (
  echo [WARN] tools\client-public.mjs nav - nemu no GitHub...
  curl.exe -fsSL -o "%TEMP%\vs-client-public.mjs" "https://raw.githubusercontent.com/voldis1994/VS/main/tools/client-public.mjs"
  start "MR-ClientPublic" /D "%ROOT%" cmd /k set CLIENT_PUBLIC_PORT=18080^& set CLIENT_DIST=%ROOT%\apps\dashboard\dist-client^& node "%TEMP%\vs-client-public.mjs"
)
echo [..] gaidu publisko paneli :18080 ...
call :wait_port 18080 40

echo [..] parbaudu ka tas NAV Vite allowedHosts...
if not exist "%ROOT%\tools\check-public.mjs" (
  mkdir "%ROOT%\tools" >nul 2>&1
  curl.exe -fsSL -o "%ROOT%\tools\check-public.mjs" "https://raw.githubusercontent.com/voldis1994/VS/main/tools/check-public.mjs"
)
set "PUBLIC_OK=0"
set /a _h=0
:health_loop
node "%ROOT%\tools\check-public.mjs"
if not errorlevel 1 (
  set "PUBLIC_OK=1"
  goto :health_done
)
set /a _h+=1
if !_h! GEQ 15 goto :health_done
echo [..] gaidu paneli :18080 ... !_h!/15
ping -n 3 127.0.0.1 >nul
goto :health_loop
:health_done
if not "!PUBLIC_OK!"=="1" (
  node "%ROOT%\tools\check-public.mjs"
  if !ERRORLEVEL! EQU 9 (
    color 0C
    echo [KLUDA] Ports 18080 atbild ka Vite. Tuneli NEATVERU.
    echo         Aizver visus MR-* un cloudflared logus, tad palaid VS.bat velreiz.
    pause
    exit /b 1
  )
  netstat -ano 2>nul | findstr ":18080 " | findstr LISTENING >nul
  if errorlevel 1 (
    color 0C
    echo [KLUDA] Ports 18080 nav atverts. Skaties logu MR-ClientPublic.
    pause
    exit /b 1
  )
  echo [WARN] veselibas parbaude neizdevas, bet :18080 klausas - atveru tuneli.
) else (
  echo [OK] publiskais panelis nav Vite
)
echo.

start "MR-Dashboard" /D "%ROOT%\apps\dashboard" cmd /k npm run dev
start "" "http://127.0.0.1:18080"
start http://localhost:5173/clients
echo [OK] lokali panelis http://127.0.0.1:18080
echo [OK] admin lokali http://localhost:5173/  (klientam NESUTI)
echo.

echo [5/5] Klienta tunelis uz :18080  (NE Vite, NE :5173, NE :5174)
echo.
echo ============================================================
echo   NEAIZVER SO LOGU
echo   Suti klientam TIKAI so https://....trycloudflare.com
echo ============================================================
echo.

where cloudflared >nul 2>&1
if not errorlevel 1 (
  cloudflared tunnel --url http://127.0.0.1:18080
  goto :eof
)
npx --yes cloudflared tunnel --url http://127.0.0.1:18080
exit /b %ERRORLEVEL%

:ensure_docker
where docker >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\Docker\Docker\resources\bin\docker.exe" (
    set "PATH=%ProgramFiles%\Docker\Docker\resources\bin;%PATH%"
    echo [OK] Atrada docker.exe
  )
)
where docker >nul 2>&1
if errorlevel 1 (
  echo [KLUDA] docker.exe nav PATH. Instale Docker Desktop un restarte datoru.
  exit /b 1
)
docker info >nul 2>&1
if not errorlevel 1 (
  echo [OK] Docker Engine darbojas
  exit /b 0
)
echo [..] Docker Desktop var but atverts, bet Engine vel startejas. Gaidu lidz 2 min...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
  start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
)
set /a _d=0
:docker_wait
docker info >nul 2>&1
if not errorlevel 1 (
  echo [OK] Docker Engine darbojas
  exit /b 0
)
set /a _d+=1
if !_d! GEQ 24 (
  echo [KLUDA] Docker CLI neatbild. Desktop ieslegts != Engine running.
  echo         Uzgaidi kamer Docker saka Engine running, tad palaid VS.bat velreiz.
  echo         Settings - General - Use the WSL 2 based engine.
  echo.
  docker info
  exit /b 1
)
echo [..] gaidu Docker Engine... !_d!/24
ping -n 6 127.0.0.1 >nul
goto :docker_wait

:wait_port
set "_PORT=%~1"
set "_MAX=%~2"
if not defined _MAX set "_MAX=60"
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
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='!ROOT!\.env'; $k='%~1'; $v='%~2'; if (-not (Test-Path -LiteralPath $p)) { Set-Content -LiteralPath $p -Value ($k+'='+$v) ; exit 0 }; $c=Get-Content -LiteralPath $p -Raw; if ($null -eq $c) { $c='' }; if ($c -match ('(?m)^'+[regex]::Escape($k)+'=')) { $c=[regex]::Replace($c,('(?m)^'+[regex]::Escape($k)+'=.*'),($k+'='+$v)) } else { if ($c.Length -gt 0 -and -not $c.EndsWith(\"`n\")) { $c+=\"`r`n\" }; $c+=($k+'='+$v+\"`r`n\") }; Set-Content -LiteralPath $p -Value $c -NoNewline"
exit /b 0

:try_build_core
where cmake >nul 2>&1
if errorlevel 1 (
  echo [WARN] CMake nav PATH
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
if errorlevel 1 exit /b 1
cmake --build build\windows-debug --config Debug --target market-core
exit /b %ERRORLEVEL%
