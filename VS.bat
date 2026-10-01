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

echo [1/5] Apturu vecos procesus + Vite...
taskkill /F /FI "WINDOWTITLE eq MR-*" >nul 2>&1
taskkill /F /IM market-core.exe >nul 2>&1
taskkill /F /IM execution-service.exe >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'vite') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
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
if exist "%ROOT%\.git" (
  cd /d "%ROOT%"
  git fetch origin main
  if errorlevel 1 (
    echo [WARN] git fetch neizdevas. Turpinu ar kodu, kas jau ir uz diska.
  ) else (
    git checkout -f main
    git reset --hard origin/main
    if errorlevel 1 (
      echo [WARN] git reset neizdevas. Turpinu ar kodu, kas jau ir uz diska.
    ) else (
      for /f "delims=" %%H in ('git rev-parse --short HEAD') do echo [OK] main  %%H
    )
  )
) else (
  echo [WARN] nav git clone - kods var but vecs.
)
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
REM Do NOT rotate MASTER_ENCRYPTION_KEY — that bricks existing broker ciphertext.
call :ensure_secret API_ADMIN_TOKEN
call :ensure_secret PIPELINE_TOKEN
call :sync_vite_admin_token
call :upsert_env OPERATING_MODE LIVE
call :upsert_env LIVE_TRADING_ENABLED true
call :upsert_env MARKET_CORE_BRIDGE 1

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

set "MC=%ROOT%\build\windows-debug\apps\market-core\market-core.exe"
if not exist "%MC%" set "MC=%ROOT%\build\windows-release\apps\market-core\market-core.exe"
if not exist "%MC%" (
  echo [..] market-core.exe nav - meginu C++ build...
  call :try_build_core
  set "MC=%ROOT%\build\windows-debug\apps\market-core\market-core.exe"
  if not exist "!MC!" set "MC=%ROOT%\build\windows-release\apps\market-core\market-core.exe"
)
if exist "%MC%" (
  call :read_env_var PIPELINE_TOKEN
  call :read_env_var PIPELINE_SERVICE_TOKEN
  call :read_env_var CONTROL_API_URL
  call :read_env_var CAPITAL_API_KEY
  call :read_env_var CAPITAL_API_PASSWORD
  call :read_env_var CAPITAL_IDENTIFIER
  call :read_env_var CAPITAL_ENVIRONMENT
  if not defined CONTROL_API_URL set "CONTROL_API_URL=http://127.0.0.1:3000"
  if not defined CAPITAL_ENVIRONMENT set "CAPITAL_ENVIRONMENT=demo"
  if "!CAPITAL_API_KEY!"=="" (
    echo [WARN] CAPITAL_API_KEY nav .env — market-core bridge IZLAIZU.
    echo        Desk/roboti strada caur Brokers DB ^(control-api^). Nav kludas.
  ) else if "!CAPITAL_API_PASSWORD!"=="" (
    echo [WARN] CAPITAL_API_PASSWORD nav .env — market-core bridge IZLAIZU.
  ) else if "!CAPITAL_IDENTIFIER!"=="" (
    echo [WARN] CAPITAL_IDENTIFIER nav .env — market-core bridge IZLAIZU.
  ) else (
    start "MR-MarketCore" /D "%ROOT%" cmd /k set MARKET_CORE_BRIDGE=1^& set OPERATING_MODE=LIVE^& set LIVE_TRADING_ENABLED=true^& set PIPELINE_TOKEN=!PIPELINE_TOKEN!^& set PIPELINE_SERVICE_TOKEN=!PIPELINE_SERVICE_TOKEN!^& set CONTROL_API_URL=!CONTROL_API_URL!^& set CAPITAL_API_KEY=!CAPITAL_API_KEY!^& set CAPITAL_API_PASSWORD=!CAPITAL_API_PASSWORD!^& set CAPITAL_IDENTIFIER=!CAPITAL_IDENTIFIER!^& set CAPITAL_ENVIRONMENT=!CAPITAL_ENVIRONMENT!^& "%MC%" --mode LIVE --bridge
    echo [OK] market-core bridge
  )
) else (
  echo [WARN] market-core.exe nav
)

set "EX=%ROOT%\build\windows-debug\apps\execution-service\execution-service.exe"
if not exist "%EX%" set "EX=%ROOT%\build\windows-release\apps\execution-service\execution-service.exe"
if exist "%EX%" start "MR-Execution" /D "%ROOT%" cmd /k "%EX%" --mode LIVE

REM Live stack: NO tsx watch — BRAIN writing .ts must not kill API mid-trade
REM (watch caused Failed to fetch / LIVE LOG stale). Code reload = exit 75 when FLAT.
start "MR-ControlAPI" /D "%ROOT%" cmd /k set CLIENT_PANEL_DIST=%ROOT%\apps\dashboard\dist-client^& node tools\control-api-live-loop.mjs
echo [..] gaidu API :3000 ...
call :wait_port 3000 40

REM Autonomous trading-brain self-improve — separate CMD (lot/broker/security blocked)
if exist "%ROOT%\BRAIN.bat" (
  start "MR-BrainSelfImprove" /D "%ROOT%" cmd /k call BRAIN.bat
  echo [OK] BRAIN self-improve logs → MR-BrainSelfImprove
) else (
  echo [WARN] BRAIN.bat nav — smadzenes nepalaizas autonomi
)

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
start http://localhost:5173/
echo [OK] lokali panelis http://127.0.0.1:18080
echo [OK] admin COMMAND http://localhost:5173/  (klientam NESUTI)
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

:ensure_secret
REM Generate a unique secret if missing or still CHANGE_ME*
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='!ROOT!\.env'; $k='%~1'; if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType File -Path $p | Out-Null }; $c=Get-Content -LiteralPath $p -Raw; if ($null -eq $c) { $c='' }; $m=[regex]::Match($c,('(?m)^'+[regex]::Escape($k)+'=(.*)$')); $cur= if($m.Success){$m.Groups[1].Value.Trim()}else{''}; if ($cur -and $cur -notmatch '^CHANGE_ME') { exit 0 }; $bytes=New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes); $v=[BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant(); if ($c -match ('(?m)^'+[regex]::Escape($k)+'=')) { $c=[regex]::Replace($c,('(?m)^'+[regex]::Escape($k)+'=.*'),($k+'='+$v)) } else { if ($c.Length -gt 0 -and -not $c.EndsWith(\"`n\")) { $c+=\"`r`n\" }; $c+=($k+'='+$v+\"`r`n\") }; Set-Content -LiteralPath $p -Value $c -NoNewline; Write-Host ('[OK] generated '+$k)"
exit /b 0

:sync_vite_admin_token
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root='!ROOT!'; $envFile=Join-Path $root '.env'; $dash=Join-Path $root 'apps\dashboard\.env.local'; $c=Get-Content -LiteralPath $envFile -Raw; $m=[regex]::Match($c,'(?m)^API_ADMIN_TOKEN=(.*)$'); if(-not $m.Success){exit 0}; $tok=$m.Groups[1].Value.Trim(); $out=@('VITE_ADMIN_TOKEN='+$tok,'VITE_API_URL=http://localhost:3000','VITE_WS_URL=ws://localhost:3000/ws'); Set-Content -LiteralPath $dash -Value ($out -join \"`r`n\")"
exit /b 0

:read_env_var
set "%~1="
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /B /C:"%~1=" "%ROOT%\.env" 2^>nul`) do set "%~1=%%B"
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
