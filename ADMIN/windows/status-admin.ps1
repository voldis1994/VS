#Requires -Version 5.1
$ErrorActionPreference = "Continue"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$Cfg = Join-Path $AdminRoot "config\control-panel.env"
Set-Location $AdminRoot

Write-Host "VS ADMIN STATUS"

$token = $env:API_ADMIN_TOKEN
if (Test-Path $Cfg) {
  Get-Content $Cfg | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { return }
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1).Trim()
    if ($k -eq "API_ADMIN_TOKEN" -or $k -eq "VITE_API_ADMIN_TOKEN") { $script:token = $v }
  }
}

Write-Host "Resolving endpoint (LAN first)..."
$resolveOut = & npx --yes tsx app/resolveAdminEndpoint.ts 2>&1
$serverUrl = $null
$transport = "?"
$serverId = "VS-CORE-01"
$ok = $false
foreach ($line in ($resolveOut | ForEach-Object { "$_" })) {
  if ($line -match '^SERVER_URL=(.+)$') { $serverUrl = $matches[1].Trim() }
  if ($line -match '^TRANSPORT=(.+)$') { $transport = $matches[1].Trim() }
  if ($line -match '^SERVER_ID=(.+)$') { $serverId = $matches[1].Trim() }
  if ($line -match '^OK=1') { $ok = $true }
}

if (-not $ok -or -not $serverUrl) {
  Write-Host "CONNECTION: DISCONNECTED"
  Write-Host "SERVER OFFLINE"
  Write-Host "TRANSPORT: (none — LAN unreachable; WireGuard not required for home ADMIN)"
  Write-Host "RESULT=FAIL"
  exit 1
}

Write-Host "TARGET $serverUrl"
Write-Host "TRANSPORT: $transport"

if ($token) {
  try {
    $headers = @{ "x-admin-token" = $token; "Accept" = "application/json" }
    $snap = Invoke-RestMethod -Uri "$serverUrl/api/v1/admin/snapshot" -Headers $headers -TimeoutSec 8
    Write-Host "SERVER: $($snap.server_id)"
    Write-Host "TRANSPORT: $transport"
    Write-Host "SERVER_URL: $serverUrl"
    Write-Host "AUTH: OK"
    Write-Host "CONNECTION: CONNECTED"
    Write-Host "CORE: $($snap.core.state)"
    Write-Host "RESULT=SUCCESS"
    exit 0
  } catch {
    Write-Host "AUTH: FAIL"
    Write-Host "CONNECTION: AUTH_FAILED"
    Write-Host "Health/discovery OK but ADMIN_SNAPSHOT failed — check API_ADMIN_TOKEN"
    Write-Host "RESULT=FAIL"
    exit 1
  }
}

Write-Host "SERVER: $serverId"
Write-Host "SERVER_URL: $serverUrl"
Write-Host "CONNECTION: REACHABLE (no token for snapshot)"
Write-Host "RESULT=SUCCESS"
exit 0
