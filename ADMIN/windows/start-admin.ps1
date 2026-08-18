#Requires -Version 5.1
<#
.SYNOPSIS
  ONE PC: start VS on this MSI (no i3 server).
  Postgres+Redis (Docker) → Control API :3000 → C++ calc → web control panel + client web.
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

$cfgDir = Join-Path $AdminRoot "config"
$envFile = Join-Path $cfgDir "single-box.env"
$clientUrlFile = Join-Path $cfgDir "client-url.txt"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null

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
    "VS_PUBLIC_CLIENT_URL=http://127.0.0.1:3000/",
    "NODE_ENV=production"
  ) | Set-Content -Path $envFile -Encoding ascii
}

if (-not (Test-Path $clientUrlFile)) {
  Set-Content -Path $clientUrlFile -Value "http://127.0.0.1:3000/" -Encoding ascii
}

Import-EnvFile $envFile
Copy-Item $envFile (Join-Path $RepoRoot "SERVER\control-api\.env") -Force
Copy-Item $envFile (Join-Path $RepoRoot ".env") -Force

Write-Host "========================================"
Write-Host " VS — ONE PC (MSI)"
Write-Host " Control panel  http://127.0.0.1:3000/admin/"
Write-Host " Client web     http://127.0.0.1:3000/"
Write-Host " C++ calc       vs-calc  (EntryReady only)"
Write-Host "========================================"

$compose = Join-Path $RepoRoot "SERVER\database\docker-compose.yml"
$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
  Write-Host "Starting Postgres + Redis (Docker)..."
  & docker compose -f $compose --env-file $envFile up -d
  if ($LASTEXITCODE -ne 0) {
    Write-Host "WARN: docker compose failed — will try existing 127.0.0.1:5432"
  } else {
    Start-Sleep -Seconds 4
  }
} else {
  Write-Host "WARN: Docker not on PATH — Postgres must already listen on 127.0.0.1:5432"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Fail "Install Node.js LTS, then START_MSI.bat again" }
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Write-Fail "npm missing" }

$apiDir = Join-Path $RepoRoot "SERVER\control-api"
if (-not (Test-Path (Join-Path $apiDir "node_modules"))) {
  Write-Host "npm install control-api..."
  Push-Location $apiDir
  & npm install --omit=dev
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail "npm install control-api failed" }
  Pop-Location
}

$clientDir = Join-Path $RepoRoot "CLIENT\web"
if (-not (Test-Path (Join-Path $clientDir "dist\index.html"))) {
  Write-Host "Building CLIENT web..."
  Push-Location $clientDir
  if (-not (Test-Path "node_modules")) { & npm install }
  & npm run build
  Pop-Location
}

$logDir = Join-Path $cfgDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$apiLog = Join-Path $logDir "control-api.out.log"

# stop leftover native Admin
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'VS Admin' -or ($_.CommandLine -and $_.CommandLine -match 'ADMIN\\desktop\\main\.py') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

function Test-Port3000 {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/health" -UseBasicParsing -TimeoutSec 2
    return $r.StatusCode -ge 200
  } catch { return $false }
}

if (-not (Test-Port3000)) {
  Write-Host "Starting Control API..."
  $tsx = Join-Path $apiDir "node_modules\tsx\dist\cli.mjs"
  if (Test-Path $tsx) {
    $p = Start-Process -FilePath $node.Source -ArgumentList @($tsx, "src/index.ts") -WorkingDirectory $apiDir -RedirectStandardOutput $apiLog -RedirectStandardError ($apiLog + ".err") -WindowStyle Hidden -PassThru
  } else {
    Push-Location $apiDir
    & npm install tsx --no-save | Out-Null
    Pop-Location
    $p = Start-Process -FilePath $node.Source -ArgumentList @("node_modules\tsx\dist\cli.mjs", "src/index.ts") -WorkingDirectory $apiDir -RedirectStandardOutput $apiLog -RedirectStandardError ($apiLog + ".err") -WindowStyle Hidden -PassThru
  }
  if (-not $p) { Write-Fail "could not start Control API" }
    $pidDir = Join-Path $env:LOCALAPPDATA "VS\admin"
    New-Item -ItemType Directory -Force -Path $pidDir | Out-Null
    $p.Id | Set-Content (Join-Path $pidDir "vs-api.pid") -Encoding ascii
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Port3000) { $ok = $true; break }
  }
  if (-not $ok) { Write-Fail "Control API did not listen on :3000 — see ADMIN\config\logs" }
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

$url = "http://127.0.0.1:3000/admin/"
Write-Host ("Opening " + $url)
Start-Process $url

Write-Host "VS READY"
Write-Host "  ADMIN   http://127.0.0.1:3000/admin/"
Write-Host "  CLIENT  http://127.0.0.1:3000/"
Write-Host "  CALC    C++ vs-calc → /api/pipeline/intents"
Write-Host "STOP: powershell -File ADMIN\windows\stop-admin.ps1"
exit 0
