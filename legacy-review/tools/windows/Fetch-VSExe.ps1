# Fetch-VSExe.ps1 — download + validate VS.exe (safe replace).
# Used by VS.bat and FIX.ps1. Do not use raw size floors as a "newness" check.
param(
  [string]$Root = "",
  [switch]$StartAfter
)

$ErrorActionPreference = 'Stop'
if (-not $Root) {
  if ($PSScriptRoot) {
    # tools/windows -> repo root
    $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  } else {
    $Root = (Get-Location).Path
  }
}
Set-Location $Root

function Write-Step([string]$msg) { Write-Host $msg }
function Fail([string]$code, [string]$msg) {
  Write-Host "[KLUDA] $code — $msg" -ForegroundColor Red
  throw "$code: $msg"
}

function Test-PeMz([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $fs = [IO.File]::OpenRead($path)
  try {
    if ($fs.Length -lt 64) { return $false }
    $b0 = $fs.ReadByte(); $b1 = $fs.ReadByte()
    return ($b0 -eq 0x4D -and $b1 -eq 0x5A) # MZ
  } finally { $fs.Close() }
}

function Get-Sha256([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-GithubRaw([string]$uri, [string]$outFile) {
  $headers = @{
    Accept              = 'application/vnd.github.raw'
    'User-Agent'        = 'VS-Fetch-VSExe'
    'Cache-Control'     = 'no-cache'
  }
  Invoke-WebRequest -Uri $uri -Headers $headers -OutFile $outFile -UseBasicParsing -TimeoutSec 600
}

Write-Step "VS fetch — mape: $Root"
if (-not (Test-Path -LiteralPath (Join-Path $Root 'apps\dashboard\package.json'))) {
  Fail 'NOT_VS_ROOT' 'Nav VS mape (vajag apps\dashboard). Palaid no C:\VS-main'
}

$tmp = Join-Path $Root 'VS.exe.download'
$dst = Join-Path $Root 'VS.exe'
$bak = Join-Path $Root 'VS.exe.bak'
$manifestLocal = Join-Path $Root 'VS.exe.sha256'
$manifestTmp = Join-Path $Root 'VS.exe.sha256.download'

Remove-Item -LiteralPath $tmp, $manifestTmp -Force -ErrorAction SilentlyContinue

# 1) Manifest from GitHub API (authoritative hash for main VS.exe)
$manifestUri = 'https://api.github.com/repos/voldis1994/VS/contents/VS.exe.sha256?ref=main'
$expectedHash = $null
$expectedSize = $null
$expectedLauncher = $null
try {
  Write-Step "[..] lejupieladeju VS.exe.sha256 (API)"
  Get-GithubRaw $manifestUri $manifestTmp
  $lines = Get-Content -LiteralPath $manifestTmp | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  if ($lines.Count -ge 1) { $expectedHash = $lines[0].Split(' ')[0].ToLowerInvariant() }
  if ($lines.Count -ge 2) {
    $parsed = 0L
    if ([long]::TryParse($lines[1], [ref]$parsed)) { $expectedSize = $parsed }
  }
  if ($lines.Count -ge 3) { $expectedLauncher = $lines[2] }
  Write-Step "[OK] manifest hash=$expectedHash size=$expectedSize launcher=$expectedLauncher"
  Copy-Item -LiteralPath $manifestTmp -Destination $manifestLocal -Force
} catch {
  Write-Step "[WARN] manifest nav pieejams: $($_.Exception.Message)"
  Write-Step "[WARN] turpinu ar PE + min izmēra pārbaudi (bez SHA256)"
}

# 2) Single primary binary URL — GitHub Contents API (bypasses stale raw CDN)
$exeUri = 'https://api.github.com/repos/voldis1994/VS/contents/VS.exe?ref=main'
$downloaded = $false
$lastErr = ''
try {
  Write-Step "[..] lejupieladeju VS.exe ← api.github.com contents (primary)"
  Get-GithubRaw $exeUri $tmp
  $downloaded = $true
} catch {
  $lastErr = $_.Exception.Message
  Write-Step "[WARN] API download: $lastErr"
}

# 3) One ZIP fallback if API failed (same tree as main — not three identical raw mirrors)
if (-not $downloaded) {
  try {
    Write-Step "[..] ZIP fallback ← codeload.github.com/.../zip/refs/heads/main"
    $zip = Join-Path $Root 'VS.exe.zip'
    Invoke-WebRequest -Uri 'https://codeload.github.com/voldis1994/VS/zip/refs/heads/main' -OutFile $zip -UseBasicParsing -TimeoutSec 600 -Headers @{ 'User-Agent' = 'VS-Fetch-VSExe' }
    $dir = Join-Path $env:TEMP ('vs-unzip-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $dir | Out-Null
    try {
      Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
      $found = Get-ChildItem -LiteralPath $dir -Recurse -Filter 'VS.exe' | Select-Object -First 1
      if (-not $found) { Fail 'ZIP_NO_EXE' 'ZIP iekšā nav VS.exe' }
      Copy-Item -LiteralPath $found.FullName -Destination $tmp -Force
      $downloaded = $true
      Write-Step "[OK] VS.exe izvilkts no ZIP"
    } finally {
      Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Fail 'DOWNLOAD_FAILED' "Nevar lejupieladet VS.exe. API: $lastErr / ZIP: $($_.Exception.Message)"
  }
}

# 4) Validate — explicit reasons (never one vague "CDN deve veco failu")
if (-not (Test-Path -LiteralPath $tmp)) {
  Fail 'DOWNLOADED_FILE_MISSING' 'Pagaidu fails VS.exe.download nav izveidots'
}

$len = (Get-Item -LiteralPath $tmp).Length
Write-Step "[..] lejupieladets bytes=$len"
if ($len -lt 1000000) {
  Fail 'DOWNLOADED_FILE_SIZE_INVALID' "Fails parak mazs ($len bytes) — ticami HTML/error lapa, ne EXE"
}
if ($len -gt 80000000) {
  Fail 'DOWNLOADED_FILE_SIZE_INVALID' "Fails parak liels ($len bytes)"
}
if ($expectedSize -and [math]::Abs($len - $expectedSize) -gt 0) {
  # Soft warn if size differs but hash may still be checked; hard-fail only on hash
  Write-Step "[WARN] izmērs ($len) != manifest ($expectedSize) — pārbaudīšu SHA256"
}

if (-not (Test-PeMz $tmp)) {
  Fail 'NOT_VALID_PE_EXECUTABLE' 'Fails nav Windows PE (nav MZ header) — noraidu (biezi GitHub HTML)'
}
Write-Step '[OK] PE/MZ header derigs'

$gotHash = Get-Sha256 $tmp
Write-Step "[..] SHA256=$gotHash"
if ($expectedHash) {
  if ($gotHash -ne $expectedHash) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Fail 'SHA256_MISMATCH' "Sagaidiju $expectedHash, sanaca $gotHash — noraidu (bojats/vecs CDN saturs)"
  }
  Write-Step '[OK] SHA256 sakrit ar VS.exe.sha256 no main'
} else {
  Write-Step '[WARN] nav manifest hash — paļaujos uz PE + size'
}

# 5) Safe replace — keep backup of previous working exe
if (Test-Path -LiteralPath $dst) {
  if (Test-PeMz $dst) {
    Copy-Item -LiteralPath $dst -Destination $bak -Force
    Write-Step '[OK] backup → VS.exe.bak'
  }
}
Move-Item -LiteralPath $tmp -Destination $dst -Force
try { Unblock-File -LiteralPath $dst } catch {}
Write-Step "[OK] VS.exe aizvietots ($len bytes, launcher=$expectedLauncher)"

Remove-Item -LiteralPath $manifestTmp -Force -ErrorAction SilentlyContinue

if ($StartAfter) {
  Write-Step '[OK] startēju VS.exe'
  Start-Process -FilePath $dst -ArgumentList $Root
  Start-Sleep -Seconds 3
  Start-Process 'http://127.0.0.1:18090'
}

exit 0
