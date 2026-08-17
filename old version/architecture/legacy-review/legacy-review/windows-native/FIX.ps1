# FIX.ps1 — recovery (Admin PowerShell). Full stack like the working ~16:00 update:
#   1) kill old processes
#   2) force GitHub ZIP source (apps/control-api etc — SL 0.20% of price)
#   3) fetch+validate VS.exe (LAUNCHER=sl20-1600)
#   cd C:\VS-main
#   iwr -UseBasicParsing -Headers @{Accept='application/vnd.github.raw';'User-Agent'='VS'} -Uri https://api.github.com/repos/voldis1994/VS/contents/FIX.ps1?ref=main -OutFile FIX.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\FIX.ps1
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $root 'apps\dashboard\package.json'))) {
  throw "Šī nav VS mape. Vispirms: cd C:\VS-main"
}

Write-Host "VS FIX — FULL UPDATE (ZIP source + VS.exe sl20-1600)..." -ForegroundColor Green
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

function Update-FromZip([string]$root) {
  Write-Host '[..] lejupieladeju GitHub ZIP (main) — source kā vakardienas 16:00 stack + SL 0.20%' -ForegroundColor Cyan
  $zip = Join-Path $env:TEMP ('vs-fix-' + [guid]::NewGuid() + '.zip')
  $dir = Join-Path $env:TEMP ('vs-fix-' + [guid]::NewGuid())
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Headers @{
      'User-Agent'    = 'VS-FIX'
      'Cache-Control' = 'no-cache'
    } -Uri 'https://codeload.github.com/voldis1994/VS/zip/refs/heads/main' -OutFile $zip
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
    $src = Get-ChildItem -LiteralPath $dir -Directory | Select-Object -First 1
    if (-not $src) { throw 'ZIP tukšs' }
    if (-not (Test-Path -LiteralPath (Join-Path $src.FullName 'apps\dashboard\package.json'))) {
      throw 'ZIP nav VS mape'
    }
    $skipFiles = @{ '.env' = $true; 'VS.exe' = $true; 'VS_RESTART.exe' = $true; 'VS.exe.bak' = $true }
    Get-ChildItem -LiteralPath $src.FullName -Recurse -Force | ForEach-Object {
      $rel = $_.FullName.Substring($src.FullName.Length).TrimStart('\', '/')
      if (-not $rel) { return }
      $top = ($rel -split '[\\/]')[0]
      if ($top -eq '.git' -or $top -eq 'node_modules') { return }
      $dest = Join-Path $root $rel
      if ($_.PSIsContainer) {
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
      } else {
        $name = Split-Path -Leaf $rel
        if ($skipFiles.ContainsKey($name)) { return }
        $parent = Split-Path -Parent $dest
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
      }
    }
    # Pin local SHA so launcher does not fight us
    try {
      $shaJson = Invoke-RestMethod -Headers @{ 'User-Agent' = 'VS-FIX' } -Uri 'https://api.github.com/repos/voldis1994/VS/commits/main'
      Set-Content -LiteralPath (Join-Path $root '.vs-build-sha') -Value ($shaJson.sha + "`n") -NoNewline
      Write-Host ("[OK] source SHA " + $shaJson.sha.Substring(0, 7)) -ForegroundColor Green
    } catch {
      Write-Host "[WARN] SHA pin: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    Write-Host '[OK] source no ZIP ielikts (SL 0.20% of price + Capital-anchor)' -ForegroundColor Green
  } finally {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  }
}

Update-FromZip $root

$dir = Join-Path $root 'tools\windows'
$ps1 = Join-Path $dir 'Fetch-VSExe.ps1'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host '[..] lejupieladeju Fetch-VSExe.ps1 caur GitHub API'
Get-GithubRaw 'tools/windows/Fetch-VSExe.ps1' $ps1

try {
  Get-GithubRaw 'VS.bat' (Join-Path $root 'VS.bat')
} catch {}

& $ps1 -Root $root -StartAfter
