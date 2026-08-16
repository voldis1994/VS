#Requires -Version 5.1
<#
.SYNOPSIS
  MSI one-shot: ensure ADMIN installed, discover i3, start Control Panel :5188.
  Prints how to create CLIENT web login (market / lot / robot START STOP).
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $AdminRoot
$Dash = Join-Path $AdminRoot "desktop"
$Cfg = Join-Path $AdminRoot "config\control-panel.env"
Set-Location $AdminRoot

Write-Host "========================================"
Write-Host " VS ADMIN START EVERYTHING"
Write-Host "========================================"

# Install if needed
$needInstall = $false
if (-not (Test-Path (Join-Path $Dash "node_modules"))) { $needInstall = $true }
if (-not (Test-Path $Cfg)) { $needInstall = $true }
if ($needInstall) {
  Write-Host "==> running INSTALL_ADMIN first..."
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install-admin.ps1")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# Optional: operator can drop IP into config\SERVER_IP.txt (one line)
$ipFile = Join-Path $AdminRoot "config\SERVER_IP.txt"
if (Test-Path $ipFile) {
  $ip = (Get-Content -LiteralPath $ipFile -TotalCount 1).Trim()
  if ($ip -match '^\d+\.\d+\.\d+\.\d+$') {
    New-Item -ItemType Directory -Force -Path (Split-Path $Cfg) | Out-Null
    if (-not (Test-Path $Cfg)) {
      @"
VS_SERVER_URL=http://${ip}:3000
VITE_API_URL=http://${ip}:3000
VS_ADMIN_TRANSPORT=lan
"@ | Set-Content -Path $Cfg -Encoding ascii
    } else {
      $lines = Get-Content $Cfg
      $out = New-Object System.Collections.Generic.List[string]
      $seen = $false
      foreach ($line in $lines) {
        if ($line -match '^\s*VS_SERVER_URL=') {
          [void]$out.Add("VS_SERVER_URL=http://${ip}:3000"); $seen = $true
        } elseif ($line -match '^\s*VITE_API_URL=') {
          [void]$out.Add("VITE_API_URL=http://${ip}:3000")
        } else {
          [void]$out.Add($line)
        }
      }
      if (-not $seen) { [void]$out.Add("VS_SERVER_URL=http://${ip}:3000") }
      $out | Set-Content -Path $Cfg -Encoding ascii
    }
    Write-Host ("Using SERVER_IP.txt -> http://{0}:3000" -f $ip)
  }
}

Write-Host ""
Write-Host "After ADMIN opens:"
Write-Host "  1) Open CLIENTS"
Write-Host "  2) Enter login name -> CREATE WEB LOGIN"
Write-Host "  3) Copy panel URL + password shown ONCE"
Write-Host "  4) Client opens that URL -> chooses market + lot -> START/STOP robot"
Write-Host "  LAN URL example:  http://<i3-LAN-IP>:3000/"
Write-Host "  Remote (WG):      http://10.77.0.1:3000/"
Write-Host ""
Write-Host "If discover fails: write i3 IP into ADMIN\config\SERVER_IP.txt then re-run."
Write-Host ""

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "start-admin.ps1")
exit $LASTEXITCODE
