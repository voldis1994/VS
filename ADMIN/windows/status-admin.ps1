#Requires -Version 5.1
$ErrorActionPreference = "Continue"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$Cfg = Join-Path $AdminRoot "config\control-panel.env"
$Conn = Join-Path $AdminRoot "config\admin.connection.json"
Set-Location $AdminRoot

Write-Host "VS ADMIN STATUS"

$serverUrl = $env:VS_SERVER_URL
$token = $env:API_ADMIN_TOKEN

if (Test-Path $Cfg) {
  Get-Content $Cfg | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { return }
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1).Trim()
    if ($k -eq "VS_SERVER_URL" -or $k -eq "VITE_API_URL") { $script:serverUrl = $v }
    if ($k -eq "API_ADMIN_TOKEN" -or $k -eq "VITE_API_ADMIN_TOKEN") { $script:token = $v }
  }
}

if (-not $serverUrl -and (Test-Path $Conn)) {
  try {
    $j = Get-Content $Conn -Raw | ConvertFrom-Json
    if ($j.baseUrl) { $serverUrl = [string]$j.baseUrl }
  } catch { }
}

if (-not $serverUrl) {
  Write-Host "CONNECTION: DISCONNECTED"
  Write-Host "FAIL: no server URL — run INSTALL_ADMIN.bat"
  exit 1
}

Write-Host "TARGET $serverUrl"

try {
  $h = Invoke-WebRequest -Uri "$serverUrl/health" -UseBasicParsing -TimeoutSec 4
  if ($h.StatusCode -lt 200 -or $h.StatusCode -ge 300) { throw "bad status" }
} catch {
  Write-Host "CONNECTION: DISCONNECTED"
  Write-Host "SERVER OFFLINE"
  Write-Host "RESULT=FAIL"
  exit 1
}

if ($token) {
  try {
    $headers = @{ "x-admin-token" = $token; "Accept" = "application/json" }
    $snap = Invoke-RestMethod -Uri "$serverUrl/api/v1/admin/snapshot" -Headers $headers -TimeoutSec 8
    Write-Host "CONNECTION: CONNECTED"
    Write-Host "SERVER: $($snap.server_id)"
    Write-Host "CORE: $($snap.core.state)"
    Write-Host "RESULT=SUCCESS"
    exit 0
  } catch {
    Write-Host "CONNECTION: AUTH_FAILED or ERROR"
    Write-Host "Health OK but ADMIN_SNAPSHOT failed — check API_ADMIN_TOKEN"
    Write-Host "RESULT=FAIL"
    exit 1
  }
}

Write-Host "CONNECTION: REACHABLE (no token for snapshot)"
Write-Host "RESULT=SUCCESS"
exit 0
