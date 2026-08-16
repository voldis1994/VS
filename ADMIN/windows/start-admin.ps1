#Requires -Version 5.1
<#
.SYNOPSIS
  Start VS ADMIN Control Panel (Vite) against real i3 VS-CORE-01.
  Does NOT start a second VS server / Postgres / Redis.
#>
$ErrorActionPreference = "Stop"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $AdminRoot
$Dash = Join-Path $RepoRoot "apps\dashboard"
$Cfg = Join-Path $AdminRoot "config\control-panel.env"
$PidFile = Join-Path $env:LOCALAPPDATA "VS\admin\control-panel.pid"
Set-Location $AdminRoot

if (-not (Test-Path (Join-Path $Dash "node_modules"))) {
  Write-Host "FAIL: run INSTALL_ADMIN.bat first"
  exit 1
}

if (-not (Test-Path $Cfg)) {
  Write-Host "FAIL: missing $Cfg — run INSTALL_ADMIN.bat first"
  exit 1
}

Get-Content $Cfg | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) { return }
  $i = $line.IndexOf("=")
  if ($i -lt 1) { return }
  $k = $line.Substring(0, $i).Trim()
  $v = $line.Substring($i + 1).Trim()
  Set-Item -Path "Env:$k" -Value $v
}

if (-not $env:VITE_API_URL) { $env:VITE_API_URL = $env:VS_SERVER_URL }
if (-not $env:VITE_API_ADMIN_TOKEN) { $env:VITE_API_ADMIN_TOKEN = $env:API_ADMIN_TOKEN }
if (-not $env:VITE_WS_URL -and $env:VITE_API_URL) {
  $env:VITE_WS_URL = ($env:VITE_API_URL -replace '^http', 'ws') + "/ws"
}

$serverUrl = $env:VS_SERVER_URL
if (-not $serverUrl) { $serverUrl = $env:VITE_API_URL }

Write-Host "VS CONTROL PANEL"
Write-Host "  API = $serverUrl"
Write-Host "  UI  = http://127.0.0.1:5173"
Write-Host "  (This PC is ADMIN only — SERVER stays on i3 VS-CORE-01)"

$healthOk = $false
try {
  $r = Invoke-WebRequest -Uri "$serverUrl/health" -UseBasicParsing -TimeoutSec 5
  if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { $healthOk = $true }
} catch {
  $healthOk = $false
}

if (-not $healthOk) {
  Write-Host ""
  Write-Host "SERVER OFFLINE"
  Write-Host "  Cannot reach $serverUrl/health"
  Write-Host "  [i3 SERVER] sudo bash SERVER/STATUS_SERVER"
  Write-Host "  Same Wi-Fi as i3, or WireGuard tunnel with VS-ADMIN-01.conf"
  exit 1
}
Write-Host "  health OK"

# Clear stale pid
New-Item -ItemType Directory -Force -Path (Split-Path $PidFile) | Out-Null
if (Test-Path $PidFile) {
  $old = Get-Content $PidFile -ErrorAction SilentlyContinue
  if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Set-Location $Dash
$env:BROWSER = "none"

# Open browser shortly after Vite binds
Start-Job -ScriptBlock {
  Start-Sleep -Seconds 3
  Start-Process "http://127.0.0.1:5173/"
} | Out-Null

Write-Host "Starting Control Panel (real API responses only)..."
Write-Host "STOP_ADMIN.bat or Ctrl+C to stop."

# Foreground — inherits VITE_* env; records PID for STOP_ADMIN
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCmd) {
  Write-Host "FAIL: npm not found on PATH"
  exit 1
}

$p = Start-Process -FilePath $npmCmd.Source -ArgumentList @("exec", "--", "vite", "--host", "127.0.0.1", "--port", "5173") `
  -WorkingDirectory $Dash -PassThru -NoNewWindow
$p.Id | Set-Content -Path $PidFile -Encoding ascii

try {
  Wait-Process -Id $p.Id
} finally {
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
