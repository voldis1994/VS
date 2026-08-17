#Requires -Version 5.1
<#
.SYNOPSIS
  Prove /health is VS-CORE with expected server_id (or legacy name field).
  Uses curl.exe + regex — PS 5.1 safe (no brittle ConvertFrom-Json on curl stdout).
#>
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$ExpectedId = 'VS-CORE-01'
)

$ErrorActionPreference = 'Stop'
$base = $Url.TrimEnd('/')
$health = $base + '/health'
$tmp = Join-Path $env:TEMP ('vs-health-' + [guid]::NewGuid().ToString('N') + '.json')

try {
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -sS --connect-timeout 5 --max-time 8 -o $tmp $health 2>"$tmp.err"
    if (-not (Test-Path $tmp)) {
      Write-Host "FAIL: no response from $health"
      exit 2
    }
    $raw = [System.IO.File]::ReadAllText($tmp)
  } else {
    $r = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 8
    if ($r.StatusCode -lt 200 -or $r.StatusCode -ge 300) {
      Write-Host "FAIL: HTTP $($r.StatusCode) from $health"
      exit 2
    }
    $raw = [string]$r.Content
  }

  if ([string]::IsNullOrWhiteSpace($raw)) {
    Write-Host "FAIL: empty body from $health"
    exit 2
  }

  if ($raw -notmatch '"service"\s*:\s*"VS-CORE"') {
    Write-Host "FAIL: not VS-CORE service at $health"
    Write-Host "  body: $($raw.Substring(0, [Math]::Min(200, $raw.Length)))"
    exit 3
  }

  $id = $null
  if ($raw -match '"server_id"\s*:\s*"([^"]+)"') { $id = $matches[1] }
  elseif ($raw -match '"name"\s*:\s*"([^"]+)"') { $id = $matches[1] }

  if (-not $id) {
    Write-Host "FAIL: /health missing server_id (and legacy name) — wrong host or stale API"
    Write-Host "  expected: $ExpectedId"
    Write-Host "  got: undefined"
    exit 4
  }

  if ($ExpectedId -and $id -ne $ExpectedId) {
    Write-Host "FAIL: identity mismatch — expected $ExpectedId got $id"
    exit 5
  }

  Write-Host "OK VS-CORE identity server_id=$id"
  exit 0
} catch {
  Write-Host "FAIL: $($_.Exception.Message)"
  exit 1
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Remove-Item ($tmp + '.err') -ErrorAction SilentlyContinue
}
