# One-time DuckDNS client-panel setup for VS (writes .env keys; token from you or prompt).
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$Token = '',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$envPath = Join-Path $Root '.env'
$domain = 'vs-system.duckdns.org'
$hostUrl = "http://$domain:18080"

if (-not (Test-Path -LiteralPath $envPath)) {
  $example = Join-Path $Root '.env.example'
  if (Test-Path -LiteralPath $example) {
    Copy-Item -LiteralPath $example -Destination $envPath
  } else {
    '' | Set-Content -LiteralPath $envPath
  }
}

function Upsert-Env($key, $value) {
  $c = Get-Content -LiteralPath $envPath -Raw
  if ($null -eq $c) { $c = '' }
  if ($c -match ('(?m)^' + [regex]::Escape($key) + '=')) {
    $c = [regex]::Replace($c, ('(?m)^' + [regex]::Escape($key) + '=.*'), ($key + '=' + $value))
  } else {
    if ($c.Length -gt 0 -and -not $c.EndsWith("`n")) { $c += "`r`n" }
    $c += ($key + '=' + $value + "`r`n")
  }
  Set-Content -LiteralPath $envPath -Value $c -NoNewline
}

$existingToken = ''
if (Test-Path -LiteralPath $envPath) {
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*DUCKDNS_TOKEN\s*=\s*(.+)\s*$') {
      $existingToken = $matches[1].Trim().Trim('"').Trim("'")
      break
    }
  }
}

$token = $Token.Trim()
if (-not $token) { $token = $existingToken }
$placeholder = @('CHANGE_ME_DUCKDNS_TOKEN', 'tavs_token_no_duckdns.org', '')
if ($placeholder -contains $token) { $token = '' }

if (-not $token -and -not $Quiet) {
  Write-Host ''
  Write-Host '=== VS DuckDNS setup ===' -ForegroundColor Cyan
  Write-Host "1) Atver https://www.duckdns.org"
  Write-Host '2) Nokopē TOKEN (garā rinda augšā, ne domēna nosaukums)'
  Write-Host ''
  $token = (Read-Host 'Ielīmē DUCKDNS_TOKEN šeit').Trim()
}

if (-not $token -or $token -eq 'CHANGE_ME_DUCKDNS_TOKEN') {
  Write-Host '[KLUDA] DUCKDNS_TOKEN nav. Palaid vēlreiz vai ieliec .env' -ForegroundColor Red
  exit 1
}

$cors = 'http://localhost:5173,http://localhost:5174,http://127.0.0.1:18080,' + $hostUrl
Upsert-Env 'PUBLIC_SHARE_MODE' 'duckdns'
Upsert-Env 'DUCKDNS_DOMAIN' $domain
Upsert-Env 'DUCKDNS_TOKEN' $token
Upsert-Env 'DUCKDNS_INTERVAL_SEC' '300'
Upsert-Env 'VITE_CLIENT_PANEL_URL' $hostUrl
Upsert-Env 'CLIENT_COOKIE_SECURE' 'false'
Upsert-Env 'CLIENT_CORS_ORIGIN' $cors

Write-Host ''
Write-Host '[OK] .env sagatavots:' -ForegroundColor Green
Write-Host "     PUBLIC_SHARE_MODE=duckdns"
Write-Host "     DUCKDNS_DOMAIN=$domain"
Write-Host '     DUCKDNS_TOKEN=*** (saglabāts)'
Write-Host "     VITE_CLIENT_PANEL_URL=$hostUrl"
Write-Host ''
Write-Host 'Nākamais (vienreiz):' -ForegroundColor Yellow
Write-Host '  Admin PowerShell:  powershell -ExecutionPolicy Bypass -File tools\open-firewall-18080.ps1'
Write-Host '  Router:            WAN 18080 -> šī PC IP : 18080'
Write-Host '  Palaist:           VS-DUCKDNS.bat'
Write-Host "  Klientam:          $hostUrl + access code"
Write-Host ''
