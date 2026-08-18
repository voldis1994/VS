#Requires -Version 5.1
<#
.SYNOPSIS
  ONE PC: start VS on this MSI (no i3 server).
  Postgres+Redis (Docker) → Control API :3000 → C++ calc → web control panel + client web.

  Do NOT uninstall Docker Desktop. This script only recycles VS postgres/redis volumes
  if the old volume password does not match ADMIN\config\single-box.env.
#>
$ErrorActionPreference = "Continue"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $AdminRoot
Set-Location $RepoRoot

function Write-Fail([string]$Msg) {
  Write-Host ("FAIL: " + $Msg)
  exit 1
}

if ((Get-Location).Path -like "*legacy-review*" -or (Get-Location).Path -like "*old version*") {
  Write-Fail "CWD is archive — production START refuses"
}

function New-Secret([int]$Bytes = 32) {
  $buf = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  return ([BitConverter]::ToString($buf) -replace '-','').ToLowerInvariant()
}

function Set-Kv([string]$File, [string]$Key, [string]$Value) {
  New-Item -ItemType Directory -Force -Path (Split-Path $File) | Out-Null
  $lines = @()
  if (Test-Path $File) {
    $lines = Get-Content $File
    $lines = $lines | Where-Object { $_ -notmatch ("^" + [regex]::Escape($Key) + "=") }
  }
  $lines += ($Key + "=" + $Value)
  Set-Content -Path $File -Value $lines -Encoding ascii
}

function Import-EnvFile([string]$File) {
  if (-not (Test-Path $File)) { return }
  Get-Content $File | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or $line -notmatch "=") { return }
    $i = $line.IndexOf("=")
    Set-Item -Path ("Env:" + $line.Substring(0, $i).Trim()) -Value $line.Substring($i + 1).Trim()
  }
}

function Show-LogTail([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  Write-Host ("---- " + $Path + " ----")
  Get-Content $Path -Tail 80
}

function Invoke-NpmInstall {
  $saved = $env:NODE_ENV
  Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
  & npm install --include=dev | Out-Host
  $code = $LASTEXITCODE
  if ($null -ne $saved -and $saved -ne "") { $env:NODE_ENV = $saved }
  return $code
}

function Get-LanIPv4 {
  try {
    $rows = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object {
        $_.IPAddress -notmatch '^127\.' -and
        $_.IPAddress -notmatch '^169\.254\.' -and
        $_.PrefixOrigin -ne 'WellKnown' -and
        $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback|Bluetooth|VMware|VirtualBox|Hyper-V|Docker|Default Switch'
      })
    $pick = $rows | Where-Object { $_.IPAddress -match '^192\.168\.' } | Select-Object -First 1
    if (-not $pick) { $pick = $rows | Where-Object { $_.IPAddress -match '^10\.' } | Select-Object -First 1 }
    if (-not $pick) { $pick = $rows | Select-Object -First 1 }
    if ($pick) { return [string]$pick.IPAddress }
  } catch { }
  return ""
}

function Open-ClientPort8443 {
  Write-Host "Firewall: allow TCP 8443 so a phone on the same Wi-Fi can open the client page..."
  try {
    & netsh advfirewall firewall delete rule name="VS CLIENT 8443" | Out-Null
  } catch { }
  try {
    & netsh advfirewall firewall add rule name="VS CLIENT 8443" dir=in action=allow protocol=TCP localport=8443 | Out-Null
  } catch {
    Write-Host "WARN: could not add firewall rule for 8443 — phone may fail until Windows allows it"
  }
}

$cfgDir = Join-Path $AdminRoot "config"
$envFile = Join-Path $cfgDir "single-box.env"
$clientUrlFile = Join-Path $cfgDir "client-url.txt"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null

$lan = Get-LanIPv4
$phoneUrl = if ($lan) { "http://" + $lan + ":8443/" } else { "http://127.0.0.1:8443/" }

if (-not (Test-Path $envFile)) {
  $dbPw = New-Secret 16
  $adminTok = New-Secret 24
  $pipeTok = New-Secret 24
  $enc = New-Secret 32
  @(
    "VS_SINGLE_BOX=1",
    "VS_LAN_TRUST_ADMIN=1",
    "VS_PRIVATE_NETWORK=0",
    "VS_LAN_MANAGEMENT=0",
    "CONTROL_API_HOST=127.0.0.1",
    "CONTROL_API_PORT=3000",
    "CONTROL_API_URL=http://127.0.0.1:3000",
    "DB_HOST=127.0.0.1",
    "DB_PORT=5432",
    "DB_NAME=market_reader",
    "DB_USER=market_reader",
    ("DB_PASSWORD=" + $dbPw),
    ("API_ADMIN_TOKEN=" + $adminTok),
    ("PIPELINE_TOKEN=" + $pipeTok),
    ("MASTER_ENCRYPTION_KEY=" + $enc),
    "JWT_SECRET=" + (New-Secret 24),
    "OPERATING_MODE=DEMO",
    "LIVE_TRADING_ENABLED=false",
    "CORS_ORIGIN=*",
    "CLIENT_COOKIE_SECURE=false",
    "VS_CLIENT_URL_FILE=" + $clientUrlFile,
    "VS_PUBLIC_CLIENT_URL=" + $phoneUrl,
    "VS_CLIENT_GATEWAY_PORT=8443",
    "VS_CLIENT_ALLOW_HTTP=1",
    "NODE_ENV=production"
  ) | Set-Content -Path $envFile -Encoding ascii
}

# Phone URL = MSI Wi-Fi IP :8443. 127.0.0.1 on a phone is the phone itself (Safari fails).
# PALAID never overwrites this once it is a custom https:// URL.
if (-not (Test-Path $clientUrlFile)) {
  Set-Content -Path $clientUrlFile -Value $phoneUrl -Encoding ascii
} else {
  $curClientUrl = ((Get-Content $clientUrlFile -Raw -ErrorAction SilentlyContinue) + "").Trim()
  if ($curClientUrl -match '^https?://(127\.0\.0\.1|localhost)(:\d+)?/?$') {
    Set-Content -Path $clientUrlFile -Value $phoneUrl -Encoding ascii
  }
}

Import-EnvFile $envFile
$env:VS_SINGLE_BOX = "1"
$stableClientUrl = ""
if (Test-Path $clientUrlFile) {
  $stableClientUrl = @(Get-Content $clientUrlFile | Where-Object { $_ -and ($_ -notmatch '^\s*#') -and ($_ -match 'https?://') } | Select-Object -First 1)
  $stableClientUrl = [string]$stableClientUrl
}
if (-not $stableClientUrl) { $stableClientUrl = $phoneUrl }
if (-not $stableClientUrl.EndsWith("/")) { $stableClientUrl = $stableClientUrl + "/" }
$env:VS_PUBLIC_CLIENT_URL = $stableClientUrl
$env:VS_CLIENT_URL_FILE = $clientUrlFile
$env:VS_LAN_IP = $lan
$env:VS_CLIENT_GATEWAY_PORT = "8443"
$env:VS_CLIENT_GATEWAY_PLAIN_PORT = "8443"
$env:VS_CLIENT_ALLOW_HTTP = "1"
$env:VS_CLIENT_GATEWAY_HOST = "0.0.0.0"
Set-Kv $envFile "VS_PUBLIC_CLIENT_URL" $stableClientUrl
Set-Kv $envFile "VS_CLIENT_URL_FILE" $clientUrlFile
Set-Kv $envFile "VS_LAN_IP" $lan
Set-Kv $envFile "VS_CLIENT_GATEWAY_PORT" "8443"
Set-Kv $envFile "VS_CLIENT_ALLOW_HTTP" "1"
Copy-Item $envFile (Join-Path $RepoRoot "SERVER\control-api\.env") -Force
Copy-Item $envFile (Join-Path $RepoRoot ".env") -Force

Write-Host "========================================"
Write-Host " VS — ONE PC (MSI)"
Write-Host " Control panel  http://127.0.0.1:3000/robot"
Write-Host " Phone page     $phoneUrl"
Write-Host " C++ calc       vs-calc  (EntryReady only)"
Write-Host " Docker Desktop stays installed"
Write-Host "========================================"

$compose = Join-Path $RepoRoot "SERVER\database\docker-compose.yml"
$docker = Get-Command docker -ErrorAction SilentlyContinue

function Invoke-VsCompose([string[]]$ComposeArgs) {
  & docker compose -f $compose --env-file $envFile @ComposeArgs
}

function Wait-PostgresHealthy {
  for ($i = 0; $i -lt 60; $i++) {
    $h = ""
    try { $h = (& docker inspect -f "{{.State.Health.Status}}" market-reader-postgres 2>$null | Out-String).Trim() } catch { $h = "" }
    if ($h -eq "healthy") { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Reset-VsDockerVolumes {
  Write-Host "Old VS Postgres volume password mismatch — recreating VS volumes only (not uninstalling Docker)"
  Invoke-VsCompose @("down", "-v")
  Invoke-VsCompose @("up", "-d", "--wait")
  if ($LASTEXITCODE -ne 0) {
    Invoke-VsCompose @("up", "-d")
    [void](Wait-PostgresHealthy)
  }
}

if ($docker) {
  Write-Host "Starting Postgres + Redis (Docker)..."
  Invoke-VsCompose @("up", "-d", "--wait")
  if ($LASTEXITCODE -ne 0) {
    Invoke-VsCompose @("up", "-d")
    if ($LASTEXITCODE -ne 0) {
      Write-Host "WARN: docker compose failed — will try existing 127.0.0.1:5432"
    } else {
      [void](Wait-PostgresHealthy)
    }
  }
} else {
  Write-Host "WARN: Docker not on PATH — Postgres must already listen on 127.0.0.1:5432"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Fail "Install Node.js LTS, then START_MSI.bat again" }
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Write-Fail "npm missing" }

$apiDir = Join-Path $RepoRoot "SERVER\control-api"
$tsx = Join-Path $apiDir "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path $tsx)) {
  Write-Host "npm install control-api..."
  Push-Location $apiDir
  $npmCode = Invoke-NpmInstall
  Pop-Location
  if ($npmCode -ne 0) { Write-Fail "npm install control-api failed" }
}

$deskDir = Join-Path $RepoRoot "ADMIN\desk"
$deskVite = Join-Path $deskDir "node_modules\vite\bin\vite.js"
$deskIndex = Join-Path $deskDir "dist\index.html"
$deskDist = Join-Path $deskDir "dist"
# Always rebuild so git pull theme/CSS changes actually show (old dist stays green otherwise).
Write-Host "Building TACTICAL DESK..."
if (Test-Path $deskDist) {
  Remove-Item -Recurse -Force $deskDist
}
Push-Location $deskDir
if (-not (Test-Path $deskVite)) {
  Write-Host "npm install ADMIN desk..."
  $npmCode = Invoke-NpmInstall
  if ($npmCode -ne 0) { Pop-Location; Write-Fail "npm install ADMIN/desk failed" }
}
if (Test-Path $deskVite) {
  & $node.Source $deskVite build
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail "TACTICAL DESK build failed" }
} else {
  Pop-Location
  Write-Fail "vite missing in ADMIN\desk"
}
Pop-Location

if (-not (Test-Path $deskIndex)) {
  Write-Fail "TACTICAL DESK missing ADMIN\desk\dist\index.html — /robot would show VS CLIENT"
}

$clientDir = Join-Path $RepoRoot "CLIENT\web"
$viteJs = Join-Path $clientDir "node_modules\vite\bin\vite.js"
$clientIndex = Join-Path $clientDir "dist\index.html"
if (-not (Test-Path $clientIndex)) {
  Write-Host "Building CLIENT web..."
  Push-Location $clientDir
  if (-not (Test-Path $viteJs)) {
    Write-Host "npm install CLIENT web (vite is not on PATH; install locally)..."
    [void](Invoke-NpmInstall)
  }
  if (Test-Path $viteJs) {
    & $node.Source $viteJs build
    if ($LASTEXITCODE -ne 0) {
      Write-Host "WARN: CLIENT web build failed — Admin panel will still open"
    }
  } else {
    Write-Host "WARN: CLIENT vite missing after npm install — Admin panel will still open"
  }
  Pop-Location
}

$logDir = Join-Path $cfgDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$apiLog = Join-Path $logDir "control-api.out.log"
$apiErr = Join-Path $logDir "control-api.err.log"

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'VS Admin' -or ($_.CommandLine -and $_.CommandLine -match 'ADMIN\\desktop\\main\.py') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

function Test-Port3000 {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/health" -UseBasicParsing -TimeoutSec 2
    return $r.StatusCode -ge 200
  } catch { return $false }
}

function Stop-LocalApi {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'control-api|src\\index\.ts' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $pidDir = Join-Path $env:LOCALAPPDATA "VS\admin"
  $pidFile = Join-Path $pidDir "vs-api.pid"
  if (Test-Path $pidFile) {
    $old = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}

function Read-ApiLogs {
  $text = ""
  if (Test-Path $apiLog) { $text += (Get-Content $apiLog -Raw -ErrorAction SilentlyContinue) }
  if (Test-Path $apiErr) { $text += (Get-Content $apiErr -Raw -ErrorAction SilentlyContinue) }
  return $text
}

function Start-ControlApiProcess {
  Stop-LocalApi
  Start-Sleep -Milliseconds 400
  Remove-Item $apiLog -Force -ErrorAction SilentlyContinue
  Remove-Item $apiErr -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path $tsx)) {
    Write-Fail "tsx missing after npm install — cannot start Control API"
  }
  $p = Start-Process -FilePath $node.Source -ArgumentList @($tsx, "src/index.ts") -WorkingDirectory $apiDir -RedirectStandardOutput $apiLog -RedirectStandardError $apiErr -WindowStyle Hidden -PassThru
  if (-not $p) { Write-Fail "could not start Control API" }
  $pidDir = Join-Path $env:LOCALAPPDATA "VS\admin"
  New-Item -ItemType Directory -Force -Path $pidDir | Out-Null
  $p.Id | Set-Content (Join-Path $pidDir "vs-api.pid") -Encoding ascii
  return $p
}

function Wait-ControlApi([System.Diagnostics.Process]$Proc) {
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Port3000) { return $true }
    if ($Proc -and $Proc.HasExited) { return $false }
  }
  return $false
}

Write-Host "Restarting Control API so /robot is TACTICAL DESK (not VS CLIENT)..."
$proc = Start-ControlApiProcess
$ok = Wait-ControlApi $proc
if (-not $ok) {
  Show-LogTail $apiLog
  Show-LogTail $apiErr
  $blob = Read-ApiLogs
  $authFail = $blob -match "DB_AUTH_FAILED|28P01|password authentication failed"
  if ($authFail -and $docker) {
    Reset-VsDockerVolumes
    Write-Host "Retrying Control API after volume recreate..."
    $proc = Start-ControlApiProcess
    $ok = Wait-ControlApi $proc
    if (-not $ok) {
      Show-LogTail $apiLog
      Show-LogTail $apiErr
    }
  }
}
if (-not $ok) {
  Write-Fail "Control API did not listen on :3000 — log tail printed above (ADMIN\config\logs)"
}

$calcDir = Join-Path $RepoRoot "SERVER\calc"
$calcExe = Join-Path $calcDir "vs-calc.exe"
if (-not (Test-Path $calcExe)) {
  Write-Host "Building C++ calc..."
  & cmd /c (Join-Path $calcDir "BUILD_CALC.bat")
}
if (Test-Path $calcExe) {
  Write-Host "Starting C++ vs-calc..."
  $calcLog = Join-Path $logDir "vs-calc.out.log"
  Start-Process -FilePath $calcExe -WorkingDirectory $calcDir -RedirectStandardError $calcLog -WindowStyle Hidden | Out-Null
} else {
  Write-Host "WARN: C++ vs-calc.exe missing — install g++ or MSVC and run SERVER\calc\BUILD_CALC.bat"
}

function Stop-ClientGateway {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'client-gateway\\gateway\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Open-ClientPort8443
Write-Host "Starting CLIENT gateway :8443 (stable URL, not trycloudflare)..."
Stop-ClientGateway
$gwJs = Join-Path $RepoRoot "SERVER\client-gateway\gateway.mjs"
if (Test-Path $gwJs) {
  $gwLog = Join-Path $logDir "client-gateway.out.log"
  $gwErr = Join-Path $logDir "client-gateway.err.log"
  Remove-Item $gwLog -Force -ErrorAction SilentlyContinue
  Remove-Item $gwErr -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $node.Source -ArgumentList @($gwJs) -WorkingDirectory (Split-Path $gwJs) -RedirectStandardOutput $gwLog -RedirectStandardError $gwErr -WindowStyle Hidden | Out-Null
} else {
  Write-Host "WARN: SERVER\client-gateway\gateway.mjs missing"
}

$url = "http://127.0.0.1:3000/robot"
Write-Host ("Opening " + $url)
Start-Process $url

Write-Host "VS READY"
Write-Host "  DESK    http://127.0.0.1:3000/robot   (this MSI only)"
Write-Host ("  PHONE   " + $stableClientUrl + "   << type this on the phone, NOT 127.0.0.1")
Write-Host "          Same Wi-Fi as the MSI. Port 8443 is required."
Write-Host "          ADMIN\config\client-url.txt  (PALAID never overwrites this once it is a custom https URL)"
Write-Host "  CALC    C++ vs-calc → /api/pipeline/intents"
Write-Host "STOP: powershell -File ADMIN\windows\stop-admin.ps1"
exit 0
