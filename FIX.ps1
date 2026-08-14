# FIX.ps1 — recovery (Admin PowerShell). Prefer API, not raw CDN:
#   cd C:\VS-main
#   iex (iwr -UseBasicParsing -Headers @{Accept='application/vnd.github.raw';'User-Agent'='VS'} https://api.github.com/repos/voldis1994/VS/contents/FIX.ps1?ref=main).Content
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $root 'apps\dashboard\package.json'))) {
  throw "Šī nav VS mape. Vispirms: cd C:\VS-main"
}

Write-Host "VS FIX — apturu procesus..." -ForegroundColor Green
Get-Process VS, VS_RESTART, node, npm, tsx -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

function Get-GithubRaw([string]$apiPath, [string]$outFile) {
  $uri = "https://api.github.com/repos/voldis1994/VS/contents/$apiPath" + '?ref=main'
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Headers @{
    Accept          = 'application/vnd.github.raw'
    'User-Agent'    = 'VS-FIX'
    'Cache-Control' = 'no-cache'
  } -Uri $uri -OutFile $outFile
}

$dir = Join-Path $root 'tools\windows'
$ps1 = Join-Path $dir 'Fetch-VSExe.ps1'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host '[..] lejupieladeju Fetch-VSExe.ps1 caur GitHub API'
Get-GithubRaw 'tools/windows/Fetch-VSExe.ps1' $ps1

try {
  Get-GithubRaw 'VS.bat' (Join-Path $root 'VS.bat')
} catch {}

& $ps1 -Root $root -StartAfter
