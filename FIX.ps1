# FIX.ps1 — recovery one-liner (Admin PowerShell):
#   cd C:\VS-main; irm https://raw.githubusercontent.com/voldis1994/VS/main/FIX.ps1 | iex
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $root 'apps\dashboard\package.json'))) {
  throw "Šī nav VS mape. Vispirms: cd C:\VS-main"
}

Write-Host "VS FIX — apturu procesus..." -ForegroundColor Green
Get-Process VS, VS_RESTART, node, npm, tsx -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$dir = Join-Path $root 'tools\windows'
$ps1 = Join-Path $dir 'Fetch-VSExe.ps1'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host '[..] lejupieladeju Fetch-VSExe.ps1'
Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Headers @{
  'User-Agent'    = 'VS-FIX'
  'Cache-Control' = 'no-cache'
} -Uri 'https://raw.githubusercontent.com/voldis1994/VS/main/tools/windows/Fetch-VSExe.ps1' -OutFile $ps1

# Also refresh VS.bat so next double-click uses the new launcher
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri 'https://raw.githubusercontent.com/voldis1994/VS/main/VS.bat' -OutFile (Join-Path $root 'VS.bat')
} catch {}

& $ps1 -Root $root -StartAfter
