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

Write-Step "Installing ADMIN npm dependencies..."
npm install
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAIL: ADMIN npm install"
  exit 1
}

$Dash = Join-Path $AdminRoot "desktop"
if (-not (Test-Path (Join-Path $Dash "package.json"))) {
  Write-Host "FAIL: ADMIN/desktop missing - Control Panel UI required"
  exit 1
}

Write-Step "Installing VS ADMIN desktop (ADMIN/desktop)..."
Push-Location $Dash
$dashOk = $true
try {
  npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: ADMIN desktop npm install"
    $dashOk = $false
  }
} finally {
  Pop-Location
}
if (-not $dashOk) {
  exit 1
}

# Continue with enrollment / discovery (remainder of original installer)
$InstallCli = Join-Path $AdminRoot "app\installAdmin.ts"
if (Test-Path $InstallCli) {
  Write-Step "Running ADMIN enrollment / discovery..."
  npx --yes tsx "$InstallCli"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "WARN: enrollment CLI returned non-zero — check LAN reachability to VS-CORE-01"
  }
} else {
  Write-Step "Enrollment CLI not present — configure config\control-panel.env manually"
}

Write-Step "========================================"
Write-Step " VS ADMIN INSTALL COMPLETE"
Write-Step " Run START_ADMIN.bat to launch Control Panel"
Write-Step "========================================"
exit 0
