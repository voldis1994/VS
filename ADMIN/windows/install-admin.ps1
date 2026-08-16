#Requires -Version 5.1
<#
.SYNOPSIS
  Install VS ADMIN on Windows MSI — deps, keys, LAN discovery, enrollment, verify snapshot.
  End user: double-click INSTALL_ADMIN.bat (no Bash).
#>
$ErrorActionPreference = "Stop"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $AdminRoot
Set-Location $AdminRoot

function Write-Step([string]$msg) { Write-Host $msg }

Write-Step "========================================"
Write-Step " VS ADMIN INSTALL — Windows"
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
$verRaw = (& node -v) -replace '^v', ''
$major = [int]($verRaw.Split('.')[0])
if ($major -lt 20) {
  Write-Host "FAIL: Node.js $verRaw found; need 20+"
  Write-Host "  Upgrade from https://nodejs.org/ then re-run INSTALL_ADMIN.bat"
  exit 1
}
Write-Step "Node.js v$verRaw OK"

# --- npm deps: ADMIN + dashboard ---
Write-Step "Installing ADMIN npm dependencies..."
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: ADMIN npm install"; exit 1 }

$Dash = Join-Path $RepoRoot "apps\dashboard"
if (Test-Path (Join-Path $Dash "package.json")) {
  Write-Step "Installing Control Panel (apps/dashboard) dependencies..."
  Push-Location $Dash
  try {
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: dashboard npm install"; exit 1 }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "FAIL: apps/dashboard missing — Control Panel UI required"
  exit 1
}

# Local data dirs (also created by installAdmin.ts)
$dataDir = Join-Path $env:LOCALAPPDATA "VS\admin"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AdminRoot "config") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir "keys") | Out-Null

# Restrict ACL on data dir (best-effort)
try {
  icacls $dataDir /inheritance:r | Out-Null
  icacls $dataDir /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null
} catch {
  Write-Host "WARN: could not tighten ACL on $dataDir"
}

# --- Orchestrated install (discover + enroll + verify) ---
Write-Step "Discovering VS-CORE-01 and completing enrollment..."
npx --yes tsx app/installAdmin.ts
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

# Soften control-panel.env ACL
$envFile = Join-Path $AdminRoot "config\control-panel.env"
if (Test-Path $envFile) {
  try {
    icacls $envFile /inheritance:r | Out-Null
    icacls $envFile /grant:r "${env:USERNAME}:F" | Out-Null
  } catch { }
}

Write-Step ""
Write-Step "Install complete. Run START_ADMIN.bat to open the Control Panel."
exit 0
