#Requires -Version 5.1
# Full MSI rebuild: STOP, git pull main, npm install, build calc/desk/client, START.
# Optional: VS_REBUILD_CLEAN=1  VS_REBUILD_SKIP_PULL=1
$ErrorActionPreference = "Continue"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $AdminRoot
Set-Location $RepoRoot

function Write-Fail {
  param([string]$Msg)
  Write-Host ("FAIL: " + $Msg) -ForegroundColor Red
  exit 1
}

if ((Get-Location).Path -like "*legacy-review*" -or (Get-Location).Path -like "*old version*") {
  Write-Fail "CWD is archive - production rebuild refuses"
}

if (-not (Test-Path (Join-Path $RepoRoot "ADMIN\windows\start-admin.ps1"))) {
  Write-Fail "not VS repo root - run from C:\VS or C:\VS-main"
}

function Invoke-NpmInstall {
  param([string]$Dir)
  $saved = $env:NODE_ENV
  Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
  Push-Location $Dir
  & npm install --include=dev | Out-Host
  $code = $LASTEXITCODE
  Pop-Location
  if ($null -ne $saved -and $saved -ne "") { $env:NODE_ENV = $saved }
  return $code
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " VS - REBUILD ALL (from scratch)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Write-Host ""
Write-Host "[1/6] STOP - kill Control API, vs-calc, client gateway..."
& (Join-Path $PSScriptRoot "stop-admin.ps1")
Start-Sleep -Seconds 2

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and (
      $_.CommandLine -match 'control-api|src\\index\.ts|vs-calc|client-gateway\\gateway\.mjs'
    )
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host ("  killed PID " + $_.ProcessId)
  }

Write-Host ""
Write-Host "[2/6] GIT - hard reset to origin/main..."
$git = Get-Command git -ErrorAction SilentlyContinue
$gitDir = Join-Path $RepoRoot ".git"
if ($git -and $env:VS_REBUILD_SKIP_PULL -ne "1" -and (Test-Path $gitDir)) {
  & git fetch origin main 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Fail "git fetch origin main failed" }
  & git checkout main 2>&1 | Out-Host
  & git reset --hard origin/main 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Fail "git reset --hard origin/main failed" }
  $head = (& git log -1 --oneline 2>$null | Out-String).Trim()
  Write-Host ("  at " + $head) -ForegroundColor Green
} else {
  if (-not (Test-Path $gitDir)) {
    Write-Host "  WARN: not a git repo (.git missing) - skip pull" -ForegroundColor Yellow
    Write-Host "  Run SETUP_GIT.bat once, or clone: git clone https://github.com/voldis1994/VS C:\VS"
  } else {
    Write-Host "  skip pull (VS_REBUILD_SKIP_PULL=1)"
  }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Fail "Node.js LTS required - install from nodejs.org" }
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Write-Fail "npm missing" }

$npmProjects = @(
  @{ Name = "control-api"; Path = (Join-Path $RepoRoot "SERVER\control-api") },
  @{ Name = "TACTICAL DESK"; Path = (Join-Path $RepoRoot "ADMIN\desk") },
  @{ Name = "CLIENT web"; Path = (Join-Path $RepoRoot "CLIENT\web") }
)

Write-Host ""
Write-Host "[3/6] NPM - install dependencies..."
if ($env:VS_REBUILD_CLEAN -eq "1") {
  Write-Host "  VS_REBUILD_CLEAN=1 - removing node_modules..."
  foreach ($p in $npmProjects) {
    $nm = Join-Path $p.Path "node_modules"
    if (Test-Path $nm) {
      Remove-Item -Recurse -Force $nm
      Write-Host ("  removed " + $p.Name + "\node_modules")
    }
  }
}
foreach ($p in $npmProjects) {
  Write-Host ("  npm install " + $p.Name + "...")
  $code = Invoke-NpmInstall -Dir $p.Path
  if ($code -ne 0) { Write-Fail ("npm install failed: " + $p.Name) }
}

Write-Host ""
Write-Host "[4/6] BUILD - C++ vs-calc (EntryReady)..."
$calcDir = Join-Path $RepoRoot "SERVER\calc"
$calcExe = Join-Path $calcDir "vs-calc.exe"
Push-Location $calcDir
& cmd /c BUILD_CALC.bat
Pop-Location
if (-not (Test-Path $calcExe)) {
  Write-Host "WARN: vs-calc.exe missing - install MinGW g++ or MSVC" -ForegroundColor Yellow
} else {
  Write-Host ("  OK " + $calcExe) -ForegroundColor Green
}

Write-Host ""
Write-Host "[5/6] BUILD - TACTICAL DESK + CLIENT web dist..."
$deskDir = Join-Path $RepoRoot "ADMIN\desk"
$deskDist = Join-Path $deskDir "dist"
$deskVite = Join-Path $deskDir "node_modules\vite\bin\vite.js"
if (Test-Path $deskDist) { Remove-Item -Recurse -Force $deskDist }
Push-Location $deskDir
& $node.Source $deskVite build
$deskCode = $LASTEXITCODE
Pop-Location
if ($deskCode -ne 0) { Write-Fail "TACTICAL DESK vite build failed" }

$clientDir = Join-Path $RepoRoot "CLIENT\web"
$clientDist = Join-Path $clientDir "dist"
$clientVite = Join-Path $clientDir "node_modules\vite\bin\vite.js"
if (Test-Path $clientDist) { Remove-Item -Recurse -Force $clientDist }
Push-Location $clientDir
& $node.Source $clientVite build
$clientCode = $LASTEXITCODE
Pop-Location
if ($clientCode -ne 0) { Write-Fail "CLIENT web vite build failed" }

Write-Host ""
Write-Host "[6/6] START - Docker + Control API + vs-calc + gateway..."
$startAdmin = Join-Path $PSScriptRoot "start-admin.ps1"
& $startAdmin
exit $LASTEXITCODE
