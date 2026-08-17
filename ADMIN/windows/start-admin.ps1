#Requires -Version 5.1
<#
.SYNOPSIS
  Canonical VS ADMIN production start (called by START_MSI.bat).
  Serves ADMIN/desktop/dist on 127.0.0.1:5188 — never Vite dev.
#>

$ErrorActionPreference = "Continue"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $AdminRoot
$Dash = Join-Path $AdminRoot "desktop"
$Runtime = Join-Path $AdminRoot "runtime\serve-admin.mjs"
$Cfg = Join-Path $AdminRoot "config\control-panel.env"
$PidFile = Join-Path $env:LOCALAPPDATA "VS\admin\control-panel.pid"
$IdentityFile = Join-Path $env:LOCALAPPDATA "VS\admin\runtime-identity.txt"
$UiPort = 5188
Set-Location $RepoRoot

function Write-Fail([string]$Msg) {
  Write-Host ("FAIL: " + $Msg)
  exit 1
}

function Get-CfgValue([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) { return $null }
  foreach ($line in Get-Content $Path) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $i = $t.IndexOf("=")
    if ($i -lt 1) { continue }
    if ($t.Substring(0, $i).Trim() -eq $Key) { return $t.Substring($i + 1).Trim() }
  }
  return $null
}

function Test-VsCoreIdentity([string]$Url) {
  if (-not $Url) { return $false }
  $u = $Url.TrimEnd("/")
  $health = $u + "/health"
  $tmp = Join-Path $env:TEMP ("vs-health-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
      & curl.exe -sS --connect-timeout 5 --max-time 8 -o $tmp $health 2>"$tmp.err"
      if (-not (Test-Path $tmp)) { return $false }
      $raw = [System.IO.File]::ReadAllText($tmp)
    } else {
      $r = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -lt 200 -or $r.StatusCode -ge 300) { return $false }
      $raw = [string]$r.Content
    }
    if ([string]::IsNullOrWhiteSpace($raw)) { return $false }
    if ($raw -notmatch '"service"\s*:\s*"VS-CORE"') { return $false }
    if ($raw -notmatch '"server_id"\s*:\s*"VS-CORE-01"') { return $false }
    return $true
  } catch {
    return $false
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Remove-Item ($tmp + ".err") -ErrorAction SilentlyContinue
  }
}

function Get-ListenPid([int]$Port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c -and $c.OwningProcess) { return [int]$c.OwningProcess }
  } catch { }
  return $null
}

function Get-ProcessCommand([int]$ProcId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcId) -ErrorAction SilentlyContinue
    if ($p) { return [string]$p.CommandLine }
  } catch { }
  try {
    $p2 = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
    if ($p2) { return $p2.ProcessName }
  } catch { }
  return ""
}

function Test-IsVsAdminCommand([string]$Cmd) {
  if (-not $Cmd) { return $false }
  return ($Cmd -match 'serve-admin\.mjs' -or $Cmd -match 'ADMIN\\desktop\\dist' -or $Cmd -match 'VS_ADMIN_DIST')
}

# --- Canonical UI hard checks ---
$Pkg = Join-Path $Dash "package.json"
$Index = Join-Path $Dash "index.html"
if (-not (Test-Path $Pkg)) { Write-Fail "ADMIN/desktop missing — run ADMIN\INSTALL_ADMIN.bat" }
$pkgJson = Get-Content $Pkg -Raw
if ($pkgJson -notmatch '"name"\s*:\s*"@vs/admin-desktop"') {
  Write-Fail "ADMIN/desktop/package.json is not @vs/admin-desktop"
}
if (-not (Test-Path $Index)) { Write-Fail "ADMIN/desktop/index.html missing" }
$idx = Get-Content $Index -Raw
if ($idx -notmatch '<title>VS ADMIN</title>') { Write-Fail "index.html title must be VS ADMIN" }
if ($idx -match 'TACTICAL|VS SYSTEM') { Write-Fail "ADMIN/desktop contains legacy tactical markers" }
if ((Get-Location).Path -like "*legacy-review*" -or (Get-Location).Path -like "*old version*") {
  Write-Fail "CWD is archive — production START refuses"
}
if (-not (Test-Path $Runtime)) { Write-Fail "missing ADMIN/runtime/serve-admin.mjs" }

# Load prior env
if (Test-Path $Cfg) {
  Get-Content $Cfg | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { return }
    Set-Item -Path ("Env:" + $line.Substring(0, $i).Trim()) -Value $line.Substring($i + 1).Trim()
  }
}

Write-Host "========================================"
Write-Host " VS ADMIN — PRODUCTION UI"
Write-Host " UI PATH = ADMIN\desktop\dist"
Write-Host " UI PORT = $UiPort  (localhost only)"
Write-Host "========================================"

# Resolve i3 URL from SERVER_IP.txt (no subnet scan)
$ipFile = Join-Path $AdminRoot "config\SERVER_IP.txt"
if (-not (Test-Path $ipFile)) { Write-Fail "missing ADMIN\config\SERVER_IP.txt — write i3 LAN IP, one line" }
$targetIp = (Get-Content -LiteralPath $ipFile -TotalCount 1).Trim()
if ($targetIp -notmatch '^\d+\.\d+\.\d+\.\d+$') { Write-Fail "SERVER_IP.txt must be an IPv4 address" }
$serverUrl = "http://${targetIp}:3000"
$transport = "LAN"
if ($targetIp -eq "10.77.0.1") { $transport = "WIREGUARD" }

Write-Host ("Target Control API = " + $serverUrl)
if (-not (Test-VsCoreIdentity $serverUrl)) {
  Write-Host "FAIL: /health is not VS-CORE-01"
  Write-Host "On i3: hostname -I && curl -fsS http://127.0.0.1:3000/health"
  Write-Host "Then write that LAN IP into ADMIN\config\SERVER_IP.txt"
  exit 1
}
Write-Host "OK identity VS-CORE-01"

# LAN bootstrap token
$adminToken = $env:VITE_API_ADMIN_TOKEN
if (-not $adminToken) { $adminToken = $env:API_ADMIN_TOKEN }
if (-not $adminToken) { $adminToken = "" }
$bootTmp = Join-Path $env:TEMP "vs-lan-boot.json"
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  & curl.exe -sS --connect-timeout 5 --max-time 8 ($serverUrl + "/api/v1/admin/lan-bootstrap") -o $bootTmp 2>$null
  if (Test-Path $bootTmp) {
    $bootRaw = [System.IO.File]::ReadAllText($bootTmp)
    if ($bootRaw -match '"api_admin_token"\s*:\s*"([^"]+)"') {
      $adminToken = $matches[1]
      Write-Host ("OK lan-bootstrap token len=" + $adminToken.Length)
    }
  }
}

$env:VS_SERVER_URL = $serverUrl
$env:VITE_API_URL = $serverUrl
$env:VS_ADMIN_TRANSPORT = $transport.ToLower()
$env:VITE_API_ADMIN_TOKEN = $adminToken
$env:API_ADMIN_TOKEN = $adminToken

New-Item -ItemType Directory -Force -Path (Split-Path $Cfg) | Out-Null
@(
  "VS_SERVER_URL=$serverUrl",
  "VITE_API_URL=$serverUrl",
  "VS_LAN_SERVER_URL=$serverUrl",
  "VS_ADMIN_TRANSPORT=$($transport.ToLower())",
  "API_ADMIN_TOKEN=$adminToken",
  "VITE_API_ADMIN_TOKEN=$adminToken"
) | Set-Content -Path $Cfg -Encoding ascii

# Runtime config for the built UI (copied into dist)
$PublicDir = Join-Path $Dash "public"
New-Item -ItemType Directory -Force -Path $PublicDir | Out-Null
$runtimeJs = @"
window.VS_ADMIN_RUNTIME = {
  product: "VS ADMIN",
  ui: "ADMIN/desktop",
  serverId: "VS-CORE-01",
  apiBase: "$serverUrl",
  adminToken: "$adminToken",
  transport: "$transport",
  deviceId: "VS-ADMIN-01",
  startedAt: "$(Get-Date -Format o)"
};
"@
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $PublicDir "runtime-config.js"), $runtimeJs, $utf8NoBom)

# Reuse existing VS ADMIN on :5188
$listenPid = Get-ListenPid $UiPort
if ($listenPid) {
  $cmd = Get-ProcessCommand $listenPid
  if (Test-IsVsAdminCommand $cmd) {
    Write-Host ("ADMIN already RUNNING pid=" + $listenPid + " — reuse")
    try { Start-Process ("http://127.0.0.1:" + $UiPort + "/") } catch { }
    Write-Host "VS ADMIN"
    Write-Host "  SERVER       VS-CORE-01"
    Write-Host "  SERVER API   CONNECTED"
    Write-Host "  TRANSPORT    $transport"
    Write-Host "  ADMIN        RUNNING"
    Write-Host "  HEARTBEAT    LIVE"
    Write-Host ("  UI           http://127.0.0.1:" + $UiPort + "/")
    exit 0
  }
  Write-Host "PORT 5188 OCCUPIED"
  Write-Host ("PID " + $listenPid)
  Write-Host ("PROCESS " + $cmd)
  Write-Host "Foreign process — not killed. Stop it or choose another host."
  exit 1
}

# Build dist if missing or stale vs source
$DistDir = Join-Path $Dash "dist"
$needBuild = $false
if (-not (Test-Path (Join-Path $DistDir "index.html"))) { $needBuild = $true }
if (-not (Test-Path (Join-Path $Dash "node_modules"))) { Write-Fail "run ADMIN\INSTALL_ADMIN.bat first" }
if ($needBuild) {
  Write-Host "Building ADMIN/desktop (production)..."
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
  if (-not $npmCmd) { Write-Fail "npm not found" }
  Push-Location $Dash
  & $npmCmd.Source run build
  $b = $LASTEXITCODE
  Pop-Location
  if ($b -ne 0) { Write-Fail "npm run build failed" }
} else {
  Write-Host "Using existing ADMIN/desktop/dist"
}
Copy-Item (Join-Path $PublicDir "runtime-config.js") (Join-Path $DistDir "runtime-config.js") -Force -ErrorAction SilentlyContinue

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) { Write-Fail "node not found" }

New-Item -ItemType Directory -Force -Path (Split-Path $PidFile) | Out-Null
$env:VS_ADMIN_DIST = $DistDir
$env:VS_ADMIN_UI_HOST = "127.0.0.1"
$env:VS_ADMIN_UI_PORT = "$UiPort"

$p = Start-Process -FilePath $node.Source `
  -ArgumentList @($Runtime) `
  -WorkingDirectory $AdminRoot `
  -PassThru `
  -NoNewWindow
if (-not $p) { Write-Fail "could not start ADMIN runtime" }
$p.Id | Set-Content -Path $PidFile -Encoding ascii
("VS-ADMIN pid=" + $p.Id + " started=" + (Get-Date -Format o) + " api=" + $serverUrl) | Set-Content -Path $IdentityFile -Encoding ascii

Start-Sleep -Seconds 1
try { Start-Process ("http://127.0.0.1:" + $UiPort + "/") } catch { }

Write-Host "VS ADMIN"
Write-Host "  SERVER       VS-CORE-01"
Write-Host "  SERVER API   CONNECTED"
Write-Host "  TRANSPORT    $transport"
Write-Host "  ADMIN        RUNNING"
Write-Host "  HEARTBEAT    (opens with UI)"
Write-Host ("  UI           http://127.0.0.1:" + $UiPort + "/")
Write-Host "STOP: ADMIN\STOP_ADMIN.bat   (does not stop i3)"

try {
  Wait-Process -Id $p.Id
  exit 0
} finally {
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
