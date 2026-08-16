# =============================================================================
# 1_START_WINDOWS.ps1 — VIENS fails PowerShell: VS ADMIN (Windows)
# =============================================================================
# Palaid:  Right-click → Run with PowerShell
# vai:     powershell -ExecutionPolicy Bypass -File .\1_START_WINDOWS.ps1
# =============================================================================
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Find-TokenFile {
  $candidates = @(
    (Join-Path $PSScriptRoot "ADMIN_TOKEN.txt"),
    (Join-Path $PSScriptRoot "..\ADMIN_TOKEN.txt"),
    "D:\ADMIN_TOKEN.txt",
    "E:\ADMIN_TOKEN.txt",
    (Join-Path $env:USERPROFILE "Desktop\ADMIN_TOKEN.txt"),
    (Join-Path $env:USERPROFILE "Desktop\VS-USB\ADMIN_TOKEN.txt")
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "FAIL: install Node.js 20 from https://nodejs.org/"
  exit 1
}

if (-not (Test-Path "node_modules")) {
  Write-Host "npm install..."
  npm install
}

$tokenFile = Find-TokenFile
if ($tokenFile) {
  Write-Host "Loading $tokenFile"
  Get-Content $tokenFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)=(.*)$') {
      Set-Item -Path "Env:$($matches[1])" -Value $matches[2].Trim()
    }
  }
}

if (-not $env:API_ADMIN_TOKEN) {
  $env:API_ADMIN_TOKEN = Read-Host "API_ADMIN_TOKEN"
}
if (-not $env:VS_SERVER_URL) {
  $env:VS_SERVER_URL = "http://192.168.0.10:3000"
}

Write-Host "Health $($env:VS_SERVER_URL)/health (LAN-first; WireGuard not required)"
try {
  $h = curl.exe -fsS --max-time 5 "$($env:VS_SERVER_URL)/health"
  Write-Host $h
} catch {
  Write-Host "FAIL: cannot reach SERVER on LAN. Prefer INSTALL_ADMIN.bat / START_ADMIN.bat"
  exit 1
}

Write-Host "Starting ADMIN..."
npx --yes tsx app/startAdmin.ts
