#Requires -Version 5.1
<#
.SYNOPSIS
  Start VS ADMIN Control Panel against real i3 VS-CORE-01.
  LAN-first: does NOT require WireGuard when home LAN reaches the server.
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
  Write-Host "FAIL: missing config\control-panel.env - run INSTALL_ADMIN.bat first"
  exit 1
}

# Load tokens / prior config (URL may be refreshed by LAN discovery below)
Get-Content $Cfg | ForEach-Object {
  $line = $_.Trim()
  if (-not $line) { return }
  if ($line.StartsWith("#")) { return }
  $i = $line.IndexOf("=")
  if ($i -lt 1) { return }
  $k = $line.Substring(0, $i).Trim()
  $v = $line.Substring($i + 1).Trim()
  Set-Item -Path ("Env:" + $k) -Value $v
}

Write-Host "Resolving VS-CORE-01 endpoint (LAN first; WireGuard only if LAN down + profile)..."
$resolveOut = & npx --yes tsx app/resolveAdminEndpoint.ts 2>&1
$resolveText = ($resolveOut | Out-String)
Write-Host $resolveText

$serverUrl = $null
$transport = "LAN"
$failed = $false
foreach ($line in @($resolveOut | ForEach-Object { [string]$_ })) {
  if ($line -match '^SERVER_URL=(.+)$') { $serverUrl = $Matches[1].Trim() }
  if ($line -match '^TRANSPORT=(.+)$') { $transport = $Matches[1].Trim() }
  if ($line -match '^OK=0') { $failed = $true }
}

if ($failed) {
  Write-Host "SERVER OFFLINE"
  Write-Host "  ADMIN does not require WireGuard on home LAN."
  Write-Host "  Verify: curl http://192.168.0.10:3000/health"
  Write-Host "  [i3 SERVER] sudo bash SERVER/STATUS_SERVER"
  exit 1
}

if (-not $serverUrl) {
  Write-Host "FAIL: could not resolve SERVER_URL"
  exit 1
}

# Persist working LAN/WG URL for Control Panel
$env:VS_SERVER_URL = $serverUrl
$env:VITE_API_URL = $serverUrl
$env:VITE_WS_URL = ($serverUrl -replace '^http', 'ws') + "/ws"
$env:VS_ADMIN_TRANSPORT = $transport.ToLower()
if (-not $env:VITE_API_ADMIN_TOKEN) {
  $env:VITE_API_ADMIN_TOKEN = $env:API_ADMIN_TOKEN
}

# Rewrite control-panel.env URL lines without dropping token
$newLines = New-Object System.Collections.Generic.List[string]
$seenUrl = $false
Get-Content $Cfg | ForEach-Object {
  $row = $_
  if ($row -match '^\s*VS_SERVER_URL=') {
    [void]$newLines.Add("VS_SERVER_URL=$serverUrl")
    $seenUrl = $true
    return
  }
  if ($row -match '^\s*VITE_API_URL=') {
    [void]$newLines.Add("VITE_API_URL=$serverUrl")
    return
  }
  if ($row -match '^\s*VITE_WS_URL=') {
    [void]$newLines.Add("VITE_WS_URL=$($env:VITE_WS_URL)")
    return
  }
  if ($row -match '^\s*VS_ADMIN_TRANSPORT=') {
    [void]$newLines.Add("VS_ADMIN_TRANSPORT=$($transport.ToLower())")
    return
  }
  if (($row -match '^\s*VS_LAN_SERVER_URL=') -and ($transport -eq 'LAN')) {
    [void]$newLines.Add("VS_LAN_SERVER_URL=$serverUrl")
    return
  }
  [void]$newLines.Add($row)
}
if (-not $seenUrl) {
  [void]$newLines.Add("VS_SERVER_URL=$serverUrl")
}
$newLines | Set-Content -Path $Cfg -Encoding ascii

Write-Host "VS CONTROL PANEL"
Write-Host "  SERVER     = VS-CORE-01"
Write-Host "  TRANSPORT  = $transport"
Write-Host "  SERVER_URL = $serverUrl"
Write-Host "  UI         = http://127.0.0.1:5173"
Write-Host "  (ADMIN only - server stays on i3)"

$healthOk = $false
try {
  $r = Invoke-WebRequest -Uri ($serverUrl + "/health") -UseBasicParsing -TimeoutSec 5
  if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) {
    $healthOk = $true
  }
} catch {
  $healthOk = $false
}

if (-not $healthOk) {
  Write-Host ""
  Write-Host "SERVER OFFLINE"
  Write-Host ("  Cannot reach " + $serverUrl + "/health")
  Write-Host "  [i3 SERVER] sudo bash SERVER/STATUS_SERVER"
  exit 1
}
Write-Host "  health OK / AUTH token loaded from install"

New-Item -ItemType Directory -Force -Path (Split-Path $PidFile) | Out-Null
if (Test-Path $PidFile) {
  $old = Get-Content $PidFile -ErrorAction SilentlyContinue
  if ($old) {
    Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Set-Location $Dash
$env:BROWSER = "none"

Start-Job -ScriptBlock {
  Start-Sleep -Seconds 3
  Start-Process "http://127.0.0.1:5173/"
} | Out-Null

Write-Host "Starting Control Panel (real API - no mock data)..."
Write-Host "STOP_ADMIN.bat or Ctrl+C to stop."

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) {
  $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npmCmd) {
  Write-Host "FAIL: npm not found on PATH"
  exit 1
}

$p = Start-Process -FilePath $npmCmd.Source `
  -ArgumentList @("exec", "--", "vite", "--host", "127.0.0.1", "--port", "5173") `
  -WorkingDirectory $Dash `
  -PassThru `
  -NoNewWindow

$p.Id | Set-Content -Path $PidFile -Encoding ascii

try {
  Wait-Process -Id $p.Id
} finally {
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
