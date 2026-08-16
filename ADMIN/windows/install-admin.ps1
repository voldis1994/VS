#Requires -Version 5.1
<#
.SYNOPSIS
  Install ONLY canonical VS ADMIN (ADMIN/desktop) on Windows MSI.
  Discovers VS-CORE-01 on LAN, enrolls ADMIN, installs deps, builds UI.
  Never installs or references legacy-review tactical desk.
#>
param(
  [switch]$Repair
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $AdminRoot
$Dash = Join-Path $AdminRoot "desktop"
Set-Location $AdminRoot

function Write-Step([string]$Message) { Write-Host $Message }
function Write-Fail([string]$Message) {
  Write-Host ("FAIL: " + $Message)
  exit 1
}

Write-Step "========================================"
if ($Repair) {
  Write-Step " VS ADMIN REPAIR — CANONICAL DESKTOP"
} else {
  Write-Step " VS ADMIN INSTALL — CANONICAL DESKTOP"
}
Write-Step " UI PATH = ADMIN\desktop"
Write-Step " NEVER = legacy-review / tactical desk / :5173"
Write-Step "========================================"

if ($env:OS -notmatch "Windows") {
  Write-Fail "This installer is for Windows. On Linux use bash ADMIN/INSTALL_ADMIN"
}

if ((Get-Location).Path -like "*legacy-review*") {
  Write-Fail "CWD is under legacy-review — production INSTALL refuses"
}

if ($PSScriptRoot -like "*legacy-review*") {
  Write-Fail "installer invoked from legacy-review"
}

# --- Node.js 20+ ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "FAIL: Node.js 20+ is required."
  Write-Host "  Install from https://nodejs.org/ (LTS 20 or newer), then re-run INSTALL_ADMIN.bat"
  Write-Host "  Or: winget install OpenJS.NodeJS.LTS"
  exit 1
}

$verRaw = (& node -v)
$verRaw = $verRaw -replace '^v', ''
$major = [int](($verRaw.Split('.'))[0])
if ($major -lt 20) {
  Write-Fail "Node.js $verRaw found; need 20+. Upgrade from https://nodejs.org/"
}
Write-Step "Node.js v$verRaw OK"

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npm) { Write-Fail "npm not found on PATH" }

# --- Canonical UI hard checks ---
$Pkg = Join-Path $Dash "package.json"
$Index = Join-Path $Dash "index.html"
if (-not (Test-Path $Pkg)) { Write-Fail "ADMIN/desktop missing — pull latest main" }
$pkgJson = Get-Content $Pkg -Raw
if ($pkgJson -notmatch '"name"\s*:\s*"@vs/admin-desktop"') {
  Write-Fail "ADMIN/desktop/package.json is not @vs/admin-desktop"
}
if (-not (Test-Path $Index)) { Write-Fail "ADMIN/desktop/index.html missing" }
$idx = Get-Content $Index -Raw
if ($idx -notmatch '<title>VS ADMIN</title>') {
  Write-Fail "ADMIN/desktop/index.html title must be VS ADMIN"
}
if ($idx -match 'TACTICAL|VS SYSTEM') {
  Write-Fail "ADMIN/desktop contains legacy tactical markers"
}

# Refuse any apps/dashboard sibling under ADMIN
$Forbidden = @(
  (Join-Path $AdminRoot "apps\dashboard"),
  (Join-Path $AdminRoot "dashboard"),
  (Join-Path $RepoRoot "apps\dashboard")
)
foreach ($f in $Forbidden) {
  if (Test-Path $f) {
    Write-Host ("WARN: forbidden UI tree exists at " + $f + " — production START will not use it")
  }
}

Write-Step "Installing ADMIN npm dependencies (connection/enrollment CLI)..."
& $npm.Source install
if ($LASTEXITCODE -ne 0) { Write-Fail "ADMIN npm install" }

Write-Step "Installing VS ADMIN desktop deps (ADMIN/desktop)..."
Push-Location $Dash
try {
  & $npm.Source install
  if ($LASTEXITCODE -ne 0) { Write-Fail "ADMIN desktop npm install" }
  Write-Step "Building VS ADMIN desktop production bundle..."
  & $npm.Source run build
  if ($LASTEXITCODE -ne 0) { Write-Fail "ADMIN desktop build" }
} finally {
  Pop-Location
}

# Scan built sources for legacy identifiers
$LegacyMarkers = @('TACTICAL DESK', 'ROBOT BRAIN', 'DRIFT GUARD', 'VS SYSTEM')
$scanRoots = @(
  (Join-Path $Dash "src"),
  (Join-Path $Dash "index.html"),
  (Join-Path $Dash "dist")
)
foreach ($root in $scanRoots) {
  if (-not (Test-Path $root)) { continue }
  $files = @()
  if (Test-Path $root -PathType Leaf) { $files = @($root) }
  else {
    $files = Get-ChildItem -Path $root -Recurse -Include *.js,*.css,*.html,*.tsx,*.ts -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch 'node_modules' }
  }
  foreach ($file in $files) {
    $pathToRead = if ($file -is [System.IO.FileSystemInfo]) { $file.FullName } else { [string]$file }
    if (-not $pathToRead) { continue }
    $text = Get-Content -LiteralPath $pathToRead -Raw -ErrorAction SilentlyContinue
    if (-not $text) { continue }
    foreach ($m in $LegacyMarkers) {
      if ($text -match [regex]::Escape($m)) {
        Write-Fail ("legacy marker '" + $m + "' found in " + $pathToRead)
      }
    }
  }
}
Write-Step "Legacy UI marker scan: PASS (none in ADMIN/desktop)"

# Ensure config dir + placeholder env for enrollment
$CfgDir = Join-Path $AdminRoot "config"
New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null
$Cfg = Join-Path $CfgDir "control-panel.env"
if (-not (Test-Path $Cfg)) {
  @"
# Written by INSTALL_ADMIN — updated by START_ADMIN after LAN discovery
VS_SERVER_URL=
VITE_API_URL=
VITE_WS_URL=
VS_ADMIN_TRANSPORT=lan
VITE_API_ADMIN_TOKEN=
API_ADMIN_TOKEN=
"@ | Set-Content -Path $Cfg -Encoding ascii
  Write-Step "Created config\control-panel.env"
}

# Enrollment / discovery against i3
$InstallCli = Join-Path $AdminRoot "app\installAdmin.ts"
if (Test-Path $InstallCli) {
  Write-Step "Running ADMIN enrollment / LAN discovery to VS-CORE-01..."
  npx --yes tsx "$InstallCli"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "WARN: enrollment CLI returned non-zero — check WiFi/LAN to i3 VS-CORE-01"
    Write-Host "  START_ADMIN.bat will re-probe common LAN URLs (192.168.0.10:3000, ...)"
  } else {
    Write-Step "Enrollment / discovery: OK"
  }
} else {
  Write-Step "Enrollment CLI not present — configure config\control-panel.env manually"
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

$serverUrl = Get-CfgValue $Cfg "VS_SERVER_URL"
if (-not $serverUrl) { $serverUrl = Get-CfgValue $Cfg "VITE_API_URL" }
$conn = "DISCONNECTED"
if ($serverUrl) {
  try {
    $r = Invoke-WebRequest -Uri ($serverUrl.TrimEnd("/") + "/health") -UseBasicParsing -TimeoutSec 4
    if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { $conn = "CONNECTED" }
  } catch { }
}

Write-Step "========================================"
Write-Step " VS ADMIN INSTALL RESULT"
Write-Step "  CANONICAL UI = ADMIN\desktop (@vs/admin-desktop)"
Write-Step "  UI PORT      = 5188 (NOT 5173)"
Write-Step "  SERVER URL   = $(if ($serverUrl) { $serverUrl } else { '(none yet — START will discover)' })"
Write-Step "  CONNECTION   = $conn"
Write-Step "  LEGACY PATH  = blocked (archive never started)"
Write-Step " Next: run START_ADMIN.bat"
Write-Step "========================================"
exit 0
