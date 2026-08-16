#Requires -Version 5.1
<#
.SYNOPSIS
  Install VS ADMIN on Windows MSI - deps, keys, LAN discovery, enrollment, verify snapshot.
  End user: double-click INSTALL_ADMIN.bat (no Bash).
#>
$ErrorActionPreference = "Stop"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $AdminRoot
Set-Location $AdminRoot

function Write-Step {
  param([string]$Message)
  Write-Host $Message
}

Write-Step "========================================"
Write-Step " VS ADMIN INSTALL - Windows"
Write-Step "========================================"

if ($env:OS -notmatch "Windows") {
  Write-Host "FAIL: This installer is for Windows. On Linux use bash ADMIN/INSTALL_ADMIN"
  exit 1
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
  Write-Host "FAIL: Node.js $verRaw found; need 20+"
  Write-Host "  Upgrade from https://nodejs.org/ then re-run INSTALL_ADMIN.bat"
  exit 1
}
Write-Step "Node.js v$verRaw OK"

# --- npm deps: ADMIN + dashboard-v2 ---
Write-Step "Installing ADMIN npm dependencies..."
npm install
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAIL: ADMIN npm install"
  exit 1
}

$DashV2 = Join-Path $AdminRoot "apps\dashboard-v2"
$DashLegacy = Join-Path $RepoRoot "Old-system\apps\dashboard"
if (Test-Path (Join-Path $DashV2 "package.json")) {
  $Dash = $DashV2
  Write-Step "Installing Control Panel v2 (ADMIN/apps/dashboard-v2)..."
} elseif (Test-Path (Join-Path $DashLegacy "package.json")) {
  $Dash = $DashLegacy
  Write-Step "Installing legacy Control Panel (Old-system/apps/dashboard)..."
} else {
  Write-Host "FAIL: dashboard-v2 missing - Control Panel UI required"
  exit 1
}

Push-Location $Dash
$dashOk = $true
try {
  npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: dashboard npm install"
    $dashOk = $false
  }
} finally {
  Pop-Location
}
if (-not $dashOk) {
  exit 1
}

# Local data dirs (also created by installAdmin.ts)
$dataDir = Join-Path $env:LOCALAPPDATA "VS\admin"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AdminRoot "config") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir "keys") | Out-Null

# Restrict ACL on data dir (best-effort)
try {
  $user = [string]$env:USERNAME
  icacls $dataDir /inheritance:r | Out-Null
  icacls $dataDir /grant:r ($user + ":(OI)(CI)F") | Out-Null
} catch {
  Write-Host ("WARN: could not tighten ACL on " + $dataDir)
}

# --- Orchestrated install (discover + enroll + verify) ---
# LAN-first: does NOT require WireGuard / 10.77.0.1 when home LAN reaches i3
Write-Step "Discovering VS-CORE-01 on LAN (WireGuard NOT required for home ADMIN)..."
npx --yes tsx app/installAdmin.ts
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

# Soften control-panel.env ACL
$envFile = Join-Path $AdminRoot "config\control-panel.env"
if (Test-Path $envFile) {
  try {
    $user = [string]$env:USERNAME
    icacls $envFile /inheritance:r | Out-Null
    icacls $envFile /grant:r ($user + ":F") | Out-Null
  } catch {
    # best-effort ACL; ignore failures
  }
}

Write-Step ""
Write-Step "Install complete. Run START_ADMIN.bat to open the Control Panel."
exit 0
