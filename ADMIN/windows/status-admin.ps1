#Requires -Version 5.1
# STATUS_ADMIN - LAN health + optional admin snapshot. No Node resolve (avoids libuv crash).
$ErrorActionPreference = "Continue"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$Cfg = Join-Path $AdminRoot "config\control-panel.env"
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

Write-Host "VS ADMIN STATUS"
Write-Host "Resolving endpoint on LAN (Wi-Fi)..."

$token = $env:API_ADMIN_TOKEN
$candidates = New-Object System.Collections.Generic.List[string]
if (Test-Path $Cfg) {
  foreach ($k in @("VS_SERVER_URL", "VITE_API_URL", "VS_LAN_SERVER_URL", "API_ADMIN_TOKEN", "VITE_API_ADMIN_TOKEN")) {
    $v = Get-CfgValue $Cfg $k
    if ($k -match "TOKEN" -and $v) { $token = $v }
    elseif ($v -and $v -notmatch '10\.77\.') { [void]$candidates.Add($v.TrimEnd("/")) }
  }
}
foreach ($c in @("http://192.168.0.10:3000", "http://192.168.0.53:3000", "http://192.168.1.10:3000")) {
  [void]$candidates.Add($c)
}

$serverUrl = $null
$seen = @{}
foreach ($c in $candidates) {
  if (-not $c) { continue }
  if ($seen.ContainsKey($c)) { continue }
  $seen[$c] = $true
  if (Test-VsHealth $c) {
    $serverUrl = $c
    break
  }
}

if (-not $serverUrl) {
  Write-Host "CONNECTION: DISCONNECTED"
  Write-Host "SERVER OFFLINE"
  Write-Host "TRANSPORT: (none)"
  Write-Host "RESULT=FAIL"
  exit 1
}

Write-Host ("TARGET " + $serverUrl)
Write-Host "TRANSPORT: LAN"

if ($token) {
  try {
    $headers = @{
      "x-admin-token" = $token
      "Accept" = "application/json"
    }
    $snap = Invoke-RestMethod -Uri ($serverUrl + "/api/v1/admin/snapshot") -Headers $headers -TimeoutSec 8
    Write-Host ("SERVER: " + $snap.server_id)
    Write-Host "TRANSPORT: LAN"
    Write-Host ("SERVER_URL: " + $serverUrl)
    Write-Host "AUTH: OK"
    Write-Host "CONNECTION: CONNECTED"
    if ($snap.core -and $snap.core.state) {
      Write-Host ("CORE: " + $snap.core.state + " (market/trading readiness - not LAN connectivity)")
    }
    Write-Host "RESULT=SUCCESS"
    exit 0
  } catch {
    Write-Host "AUTH: FAIL"
    Write-Host "CONNECTION: AUTH_FAILED"
    Write-Host "Health OK but ADMIN snapshot failed - check API_ADMIN_TOKEN"
    Write-Host "RESULT=FAIL"
    exit 1
  }
}

Write-Host "SERVER: VS-CORE-01"
Write-Host ("SERVER_URL: " + $serverUrl)
Write-Host "CONNECTION: REACHABLE (no token for snapshot)"
Write-Host "RESULT=SUCCESS"
exit 0
