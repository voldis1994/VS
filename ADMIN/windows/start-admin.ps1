#Requires -Version 5.1
<#
.SYNOPSIS
  Start VS ADMIN Control Panel against real i3 VS-CORE-01.
  LAN-first over home Wi-Fi. WireGuard NOT required when LAN reaches the server.

  Avoids Node/tsx for the common LAN path (Windows libuv UV_HANDLE_CLOSING crash).
#>

# Do NOT use Stop globally - native stderr from node must not abort START
$ErrorActionPreference = "Continue"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $AdminRoot
$Dash = Join-Path $RepoRoot "apps\dashboard"
$Cfg = Join-Path $AdminRoot "config\control-panel.env"
$PidFile = Join-Path $env:LOCALAPPDATA "VS\admin\control-panel.pid"
Set-Location $AdminRoot

function Test-VsHealth([string]$Url) {
  if (-not $Url) { return $false }
  $u = $Url.TrimEnd("/")
  try {
    $r = Invoke-WebRequest -Uri ($u + "/health") -UseBasicParsing -TimeoutSec 4
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Get-CfgValue([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) { return $null }
  foreach ($line in Get-Content $Path) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $i = $t.IndexOf("=")
    if ($i -lt 1) { continue }
    if ($t.Substring(0, $i).Trim() -eq $Key) {
      return $t.Substring($i + 1).Trim()
    }
  }
  return $null
}

function Resolve-LanServerUrl {
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($k in @("VS_SERVER_URL", "VITE_API_URL", "VS_LAN_SERVER_URL")) {
    $v = Get-CfgValue $Cfg $k
    if ($v -and $v -notmatch '10\.77\.') { [void]$candidates.Add($v.TrimEnd("/")) }
  }
  if ($env:VS_SERVER_URL -and $env:VS_SERVER_URL -notmatch '10\.77\.') {
    [void]$candidates.Add($env:VS_SERVER_URL.TrimEnd("/"))
  }
  # Known home-LAN endpoints (same list as discoverServer.ts)
  foreach ($c in @(
      "http://192.168.0.10:3000",
      "http://192.168.0.53:3000",
      "http://192.168.1.10:3000"
    )) {
    [void]$candidates.Add($c)
  }
  $seen = @{}
  foreach ($c in $candidates) {
    if (-not $c) { continue }
    if ($seen.ContainsKey($c)) { continue }
    $seen[$c] = $true
    Write-Host ("  probe " + $c + " ...")
    if (Test-VsHealth $c) {
      return $c
    }
  }
  return $null
}

if (-not (Test-Path (Join-Path $Dash "node_modules"))) {
  Write-Host "FAIL: run INSTALL_ADMIN.bat first"
  exit 1
}

if (-not (Test-Path $Cfg)) {
  Write-Host "FAIL: missing config\control-panel.env - run INSTALL_ADMIN.bat first"
  exit 1
}

# Load tokens / prior config
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

Write-Host "Resolving VS-CORE-01 on LAN (Wi-Fi) - WireGuard NOT required..."
$serverUrl = Resolve-LanServerUrl
$transport = "LAN"

if (-not $serverUrl) {
  Write-Host "SERVER OFFLINE"
  Write-Host "  Cannot reach VS-CORE-01 on home LAN/Wi-Fi."
  Write-Host "  Check i3 is on and: curl http://192.168.0.10:3000/health"
  Write-Host "  [i3 SERVER] sudo bash SERVER/STATUS_SERVER"
  exit 1
}

Write-Host ("SERVER DISCOVERED " + $serverUrl + " TRANSPORT=" + $transport)

# Persist working LAN URL for Control Panel
$env:VS_SERVER_URL = $serverUrl
$env:VITE_API_URL = $serverUrl
$env:VITE_WS_URL = ($serverUrl -replace '^http', 'ws') + "/ws"
$env:VS_ADMIN_TRANSPORT = "lan"
if (-not $env:VITE_API_ADMIN_TOKEN) {
  $env:VITE_API_ADMIN_TOKEN = $env:API_ADMIN_TOKEN
}

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
    [void]$newLines.Add("VS_ADMIN_TRANSPORT=lan")
    return
  }
  if ($row -match '^\s*VS_LAN_SERVER_URL=') {
    [void]$newLines.Add("VS_LAN_SERVER_URL=$serverUrl")
    return
  }
  [void]$newLines.Add($row)
}
if (-not $seenUrl) {
  [void]$newLines.Add("VS_SERVER_URL=$serverUrl")
}
# ASCII with BOM avoided - WriteAllLines default UTF8 no BOM on PS5 can be ok; use ascii for env
$newLines | Set-Content -Path $Cfg -Encoding ascii

Write-Host "VS CONTROL PANEL"
Write-Host "  SERVER     = VS-CORE-01"
Write-Host "  TRANSPORT  = LAN"
Write-Host "  SERVER_URL = $serverUrl"
Write-Host "  UI         = http://127.0.0.1:5173"
Write-Host "  (ADMIN only - server stays on i3)"
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

# Start vite detached from this shell's error stream
$p = Start-Process -FilePath $npmCmd.Source `
  -ArgumentList @("exec", "--", "vite", "--host", "127.0.0.1", "--port", "5173") `
  -WorkingDirectory $Dash `
  -PassThru `
  -NoNewWindow

if (-not $p) {
  Write-Host "FAIL: could not start vite"
  exit 1
}

$p.Id | Set-Content -Path $PidFile -Encoding ascii
Write-Host ("Control Panel PID=" + $p.Id)

try {
  Wait-Process -Id $p.Id
  $code = 0
  if (-not $p.HasExited) { } else { $code = $p.ExitCode }
  if ($null -eq $code) { $code = 0 }
  exit ([int]$code)
} finally {
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
