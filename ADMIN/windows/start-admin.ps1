#Requires -Version 5.1
<#
.SYNOPSIS
  Canonical VS ADMIN production start (called by START_MSI.bat).
  Launches native VS Admin.exe — never Vite, never a local HTTP UI, never a browser.
#>

$ErrorActionPreference = "Continue"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $AdminRoot
$Desktop = Join-Path $AdminRoot "desktop"
$Exe = Join-Path $PSScriptRoot "dist\VS Admin.exe"
$Cfg = Join-Path $AdminRoot "config\control-panel.env"
$PidFile = Join-Path $env:LOCALAPPDATA "VS\admin\vs-admin.pid"
Set-Location $RepoRoot

function Write-Fail([string]$Msg) {
  Write-Host ("FAIL: " + $Msg)
  exit 1
}

function Test-VsCoreIdentity([string]$Url) {
  if (-not $Url) { return $false }
  $u = $Url.TrimEnd("/")
  $health = $u + "/health"
  $tmp = Join-Path $env:TEMP ("vs-health-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
      & curl.exe -sS --connect-timeout 5 --max-time 8 -o $tmp $health 2>"$tmp.err"
      if (-not (Test-Path $tmp)) { return $false }
      $raw = [System.IO.File]::ReadAllText($tmp)
    } else {
      $r = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -lt 200 -or $r.StatusCode -ge 300) { return $false }
      $raw = [string]$r.Content
    }
    if ([string]::IsNullOrWhiteSpace($raw)) { return $false }
    if ($raw -notmatch '"service"\s*:\s*"VS-CORE"') { return $false }
    if ($raw -notmatch '"server_id"\s*:\s*"VS-CORE-01"') { return $false }
    return $true
  } catch {
    return $false
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Remove-Item ($tmp + ".err") -ErrorAction SilentlyContinue
  }
}

function Get-VsAdminProcess {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match 'VS Admin' -or
      ($_.CommandLine -and $_.CommandLine -match 'VS Admin\.exe') -or
      ($_.CommandLine -and $_.CommandLine -match 'ADMIN\\desktop\\main\.py')
    }
}

function Focus-VsAdminWindow {
  Add-Type -Namespace VsAdmin -Name Native -MemberDefinition @"
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
"@ -ErrorAction SilentlyContinue
  Get-Process | Where-Object { $_.MainWindowTitle -eq "VS Admin" } | ForEach-Object {
    [void][VsAdmin.Native]::ShowWindow($_.MainWindowHandle, 9)
    [void][VsAdmin.Native]::SetForegroundWindow($_.MainWindowHandle)
  }
}

if ((Get-Location).Path -like "*legacy-review*" -or (Get-Location).Path -like "*old version*") {
  Write-Fail "CWD is archive — production START refuses"
}
if (-not (Test-Path (Join-Path $Desktop "main.py"))) {
  Write-Fail "ADMIN/desktop/main.py missing — native Admin source required"
}

$existing = @(Get-VsAdminProcess)
if ($existing.Count -gt 0) {
  Write-Host ("ADMIN already RUNNING pid=" + $existing[0].ProcessId + " — focus existing window")
  Focus-VsAdminWindow
  Write-Host "VS ADMIN"
  Write-Host "  SERVER       VS-CORE-01"
  Write-Host "  UI           native VS Admin.exe"
  Write-Host "  NOTE         no second process started"
  exit 0
}

if (Test-Path $Cfg) {
  Get-Content $Cfg | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { return }
    Set-Item -Path ("Env:" + $line.Substring(0, $i).Trim()) -Value $line.Substring($i + 1).Trim()
  }
}

Write-Host "========================================"
Write-Host " VS ADMIN — NATIVE DESKTOP"
Write-Host " UI = VS Admin.exe  (no browser, no local HTTP UI)"
Write-Host "========================================"

$ipFile = Join-Path $AdminRoot "config\SERVER_IP.txt"
if (-not (Test-Path $ipFile)) { Write-Fail "missing ADMIN\config\SERVER_IP.txt — write i3 LAN IP, one line" }
$targetIp = (Get-Content -LiteralPath $ipFile -TotalCount 1).Trim()
if ($targetIp -notmatch '^\d+\.\d+\.\d+\.\d+$') { Write-Fail "SERVER_IP.txt must be an IPv4 address" }
$serverUrl = "http://${targetIp}:3000"
$transport = "LAN"
if ($targetIp -eq "10.77.0.1") { $transport = "WIREGUARD" }

Write-Host ("Target Control API = " + $serverUrl)
if (-not (Test-VsCoreIdentity $serverUrl)) {
  Write-Host "FAIL: /health is not VS-CORE-01"
  Write-Host "On i3: hostname -I && curl -fsS http://127.0.0.1:3000/health"
  Write-Host "Then write that LAN IP into ADMIN\config\SERVER_IP.txt"
  exit 1
}
Write-Host "OK identity VS-CORE-01"

$adminToken = $env:API_ADMIN_TOKEN
if (-not $adminToken) { $adminToken = "" }
$bootTmp = Join-Path $env:TEMP "vs-lan-boot.json"
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  & curl.exe -sS --connect-timeout 5 --max-time 8 ($serverUrl + "/api/v1/admin/lan-bootstrap") -o $bootTmp 2>$null
  if (Test-Path $bootTmp) {
    $bootRaw = [System.IO.File]::ReadAllText($bootTmp)
    if ($bootRaw -match '"api_admin_token"\s*:\s*"([^"]+)"') {
      $adminToken = $matches[1]
      Write-Host ("OK lan-bootstrap token len=" + $adminToken.Length)
    }
  }
}

$env:VS_SERVER_URL = $serverUrl
$env:VS_ADMIN_TRANSPORT = $transport
$env:API_ADMIN_TOKEN = $adminToken
$env:VS_ADMIN_TOKEN = $adminToken

New-Item -ItemType Directory -Force -Path (Split-Path $Cfg) | Out-Null
@(
  "VS_SERVER_URL=$serverUrl",
  "VS_ADMIN_TRANSPORT=$transport",
  "API_ADMIN_TOKEN=$adminToken"
) | Set-Content -Path $Cfg -Encoding ascii

New-Item -ItemType Directory -Force -Path (Split-Path $PidFile) | Out-Null
$uiKind = "VS Admin.exe"
if (Test-Path $Exe) {
  $p = Start-Process -FilePath $Exe -WorkingDirectory $Desktop -PassThru
  if (-not $p) { Write-Fail "could not start VS Admin.exe" }
} else {
  Write-Host "VS Admin.exe missing — launching python ADMIN\desktop\main.py"
  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) { Write-Fail "python not on PATH — install Python 3.12 from python.org, then START_MSI.bat" }
  & python -c "import PySide6" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing PySide6..."
    & python -m pip install -r (Join-Path $Desktop "requirements.txt")
    if ($LASTEXITCODE -ne 0) { Write-Fail "pip install PySide6 failed" }
  }
  $p = Start-Process -FilePath $py.Source -ArgumentList "main.py" -WorkingDirectory $Desktop -PassThru
  if (-not $p) { Write-Fail "could not start python ADMIN\desktop\main.py" }
  $uiKind = "python ADMIN\desktop\main.py"
}
$p.Id | Set-Content -Path $PidFile -Encoding ascii

Start-Sleep -Milliseconds 800
Write-Host "VS ADMIN"
Write-Host "  SERVER       VS-CORE-01"
Write-Host "  SERVER API   CONNECTED"
Write-Host "  TRANSPORT    $transport"
Write-Host "  ADMIN        $uiKind"
Write-Host "  UI           native window (no browser)"
Write-Host "STOP: powershell -File ADMIN\windows\stop-admin.ps1   (does not stop i3)"
exit 0
