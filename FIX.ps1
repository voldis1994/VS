# FIX.ps1 — ielime PowerShell (Admin):
#   cd C:\VS-main; irm https://raw.githubusercontent.com/voldis1994/VS/main/FIX.ps1 | iex
$ErrorActionPreference = 'Stop'
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Get-Location }
Set-Location $root
Write-Host "VS FIX — mape: $root" -ForegroundColor Green

if (-not (Test-Path '.\apps\dashboard\package.json')) {
  throw "Šī nav VS mape. Palaid no C:\VS-main"
}

Get-Process VS, VS_RESTART, node, npm, tsx -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Seconds 2

$tmp = Join-Path $root 'VS.exe.new'
$dst = Join-Path $root 'VS.exe'
function Test-VsExe([string]$p) {
  if (-not (Test-Path $p)) { return $false }
  $len = (Get-Item $p).Length
  if ($len -lt 5000000) { return $false }
  $b = [IO.File]::ReadAllBytes($p)[0..1]
  return ($b[0] -eq 0x4D -and $b[1] -eq 0x5A)
}

Remove-Item $tmp -Force -EA SilentlyContinue
$headers = @{ Accept = 'application/vnd.github.raw'; 'User-Agent' = 'VS-FIX-ps1' }
$urls = @(
  'https://api.github.com/repos/voldis1994/VS/contents/VS.exe?ref=main',
  'https://raw.githubusercontent.com/voldis1994/VS/94624a2/VS.exe',
  'https://github.com/voldis1994/VS/raw/refs/heads/main/VS.exe'
)
$ok = $false
foreach ($u in $urls) {
  try {
    Write-Host "[..] $u"
    Invoke-WebRequest -Uri $u -Headers $headers -OutFile $tmp -UseBasicParsing -TimeoutSec 600
    if (Test-VsExe $tmp) {
      Write-Host "[OK] $((Get-Item $tmp).Length) bytes"
      $ok = $true
      break
    }
    Remove-Item $tmp -Force -EA SilentlyContinue
  } catch {
    Write-Host "[WARN] $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

if (-not $ok) {
  Write-Host '[..] ZIP fallback'
  $z = Join-Path $root 'VS.exe.zip'
  Invoke-WebRequest -Uri 'https://codeload.github.com/voldis1994/VS/zip/refs/heads/main' -OutFile $z -UseBasicParsing -TimeoutSec 600
  $d = Join-Path $env:TEMP ("vs-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $d | Out-Null
  try {
    Expand-Archive -LiteralPath $z -DestinationPath $d -Force
    $exe = Get-ChildItem $d -Recurse -Filter VS.exe | Select-Object -First 1
    if ($exe) { Copy-Item $exe.FullName $tmp -Force }
  } finally {
    Remove-Item $d -Recurse -Force -EA SilentlyContinue
    Remove-Item $z -Force -EA SilentlyContinue
  }
  if (Test-VsExe $tmp) { $ok = $true }
}

if (-not $ok) { throw 'VS.exe lejupielāde neizdevās' }

Move-Item -LiteralPath $tmp -Destination $dst -Force
try { Unblock-File -LiteralPath $dst } catch {}

# Also refresh VS.bat so next double-click is the new one
try {
  Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/voldis1994/VS/main/VS.bat' -OutFile (Join-Path $root 'VS.bat') -UseBasicParsing
} catch {}

Write-Host '[OK] startēju VS.exe — panelī jabūt LAUNCHER=bridge75a0' -ForegroundColor Green
Start-Process -FilePath $dst -ArgumentList $root
Start-Sleep -Seconds 3
Start-Process 'http://127.0.0.1:18090'
