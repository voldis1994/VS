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

function Resolve-LanServerUrl {
  $candidates = New-Object System.Collections.Generic.List[string]
  $pinnedIp = $null
  $ipFile = Join-Path $AdminRoot "config\SERVER_IP.txt"
  if (Test-Path $ipFile) {
    $manualIp = (Get-Content -LiteralPath $ipFile -TotalCount 1 -ErrorAction SilentlyContinue)
    if ($manualIp) {
      $manualIp = $manualIp.Trim()
      if ($manualIp -match '^\d+\.\d+\.\d+\.\d+$') {
        $pinnedIp = $manualIp
        [void]$candidates.Add("http://${manualIp}:3000")
      }
    }
  }
  # 1) Explicit saved / env (highest priority)
  foreach ($k in @("VS_SERVER_URL", "VITE_API_URL", "VS_LAN_SERVER_URL")) {
    $v = Get-CfgValue $Cfg $k
    if ($v -and $v -notmatch '10\.77\.') { [void]$candidates.Add($v.TrimEnd("/")) }
  }
  if ($env:VS_SERVER_URL -and $env:VS_SERVER_URL -notmatch '10\.77\.') {
    [void]$candidates.Add($env:VS_SERVER_URL.TrimEnd("/"))
  }
  if ($pinnedIp) {
    # Operator pinned i3 IP — do NOT scan MSI subnet (avoids false hits like 192.168.8.10)
    $seen = @{}
    foreach ($c in $candidates) {
      if (-not $c) { continue }
      if ($seen.ContainsKey($c)) { continue }
      $seen[$c] = $true
      Write-Host ("  probe " + $c + " ...")
      if (Test-VsCoreIdentity $c) {
        Write-Host ("  OK VS-CORE at " + $c)
        return $c
      }
    }
    return $null
  }
  # 2) Known home LAN defaults (only when SERVER_IP.txt not pinned)
  foreach ($c in @(
      "http://192.168.0.10:3000",
      "http://192.168.0.53:3000",
      "http://192.168.1.10:3000"
    )) {
    [void]$candidates.Add($c)
  }
  # 3) Controlled local subnet probe (no Docker 172.x)
  foreach ($c in (Get-LocalLanProbeUrls)) { [void]$candidates.Add($c) }
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

Write-Host "MSI IPv4 (must share subnet with i3 — check SERVER_IP.txt):"
try {
  $msiPrefixes = @()
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" } |
    ForEach-Object {
      Write-Host ("  " + $_.IPAddress + "  " + $_.InterfaceAlias)
      $parts = $_.IPAddress.Split(".")
      if ($parts.Count -eq 4) { $msiPrefixes += ($parts[0] + "." + $parts[1] + "." + $parts[2]) }
    }
  $ipFile = Join-Path $AdminRoot "config\SERVER_IP.txt"
  if (Test-Path $ipFile) {
    $targetIp = (Get-Content -LiteralPath $ipFile -TotalCount 1 -ErrorAction SilentlyContinue)
    if ($targetIp -and $targetIp.Trim() -match '^(\d+\.\d+\.\d+)\.\d+$') {
      $i3Prefix = $matches[1]
      if ($msiPrefixes.Count -gt 0 -and ($msiPrefixes | Where-Object { $_ -eq $i3Prefix }).Count -eq 0) {
        Write-Host ("WARN: i3 target prefix " + $i3Prefix + ".x differs from MSI — likely wrong SERVER_IP.txt")
      }
    }
  }
} catch {
  ipconfig | Select-String "IPv4"
}

# CONNECT_FORCE / operator may pre-verify — trust and skip probe spam
$serverUrl = $null
$transport = "LAN"
if ($env:VS_ADMIN_FORCE_URL) {
  $force = $env:VS_ADMIN_FORCE_URL.TrimEnd("/")
  Write-Host ("FORCE URL from CONNECT_FORCE: " + $force)
  if (Test-VsCoreIdentity $force) {
    $serverUrl = $force
    if ($force -match '10\.77\.') { $transport = "WIREGUARD" }
    Write-Host ("OK VS-CORE forced at " + $serverUrl)
  } else {
    Write-Host "WARN: FORCE URL identity failed"
    $ipFile = Join-Path $AdminRoot "config\SERVER_IP.txt"
    if (Test-Path $ipFile) {
      Write-Host "SERVER_IP.txt is set — not scanning MSI subnet (wrong :3000 hosts)"
      Write-Host "Run ADMIN\PHYSICAL_VERIFY.bat or fix ADMIN\config\SERVER_IP.txt"
    } else {
      Write-Host "Falling back to discovery"
    }
  }
}

if (-not $serverUrl) {
  $ipFile = Join-Path $AdminRoot "config\SERVER_IP.txt"
  $hasPinned = (Test-Path $ipFile) -and ((Get-Content -LiteralPath $ipFile -TotalCount 1 -ErrorAction SilentlyContinue).Trim() -match '^\d+\.\d+\.\d+\.\d+$')
  if (-not $hasPinned) {
    Write-Host "Resolving VS-CORE-01 on LAN..."
    $serverUrl = Resolve-LanServerUrl
    $transport = "LAN"
  }
}

if (-not $serverUrl) {
  Write-Host ""
  Write-Host "LAN FAILED — diagnosing path to i3..."
  $targetIp = "192.168.0.10"
  $ipFile = Join-Path $AdminRoot "config\SERVER_IP.txt"
  if (Test-Path $ipFile) {
    $t = (Get-Content -LiteralPath $ipFile -TotalCount 1 -ErrorAction SilentlyContinue)
    if ($t -and $t.Trim() -match '^\d+\.\d+\.\d+\.\d+$') { $targetIp = $t.Trim() }
  }
  Write-Host ("  target=" + $targetIp)
  Write-Host "  ping:"
  & ping.exe -n 2 $targetIp 2>&1 | ForEach-Object { Write-Host ("    " + $_) }
  Show-ProbeDetail ("http://" + $targetIp + ":3000")

  # Retry identity with fixed checker (often succeeds even when loop failed)
  $retry = "http://" + $targetIp + ":3000"
  if (Test-VsCoreIdentity $retry) {
    $serverUrl = $retry
    $transport = "LAN"
    Write-Host ("  OK VS-CORE on retry at " + $serverUrl)
  }

  if (-not $serverUrl) {
    Write-Host "  trying WireGuard http://10.77.0.1:3000 ..."
    if (Test-VsCoreIdentity "http://10.77.0.1:3000") {
      $serverUrl = "http://10.77.0.1:3000"
      $transport = "WIREGUARD"
      Write-Host "  OK VS-CORE via WireGuard"
    }
  }
}

if (-not $serverUrl) {
  Write-Host ""
  Write-Host "SERVER OFFLINE — MSI cannot reach VS-CORE-01"
  Write-Host "If ping+HTTP 200 worked but this still fails: update scripts (git pull) — identity bug."
  Write-Host "Do this:"
  Write-Host "  cd /d C:\VS-main"
  Write-Host "  git pull origin main"
  Write-Host "  ADMIN\CONNECT_FORCE.bat"
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

if (-not (Test-Path $Exe)) {
  Write-Host "VS Admin.exe not built yet — run ADMIN\windows\BUILD_ADMIN.bat"
  Write-Fail "missing ADMIN\windows\dist\VS Admin.exe"
}

New-Item -ItemType Directory -Force -Path (Split-Path $PidFile) | Out-Null
$p = Start-Process -FilePath $Exe -WorkingDirectory $Desktop -PassThru
if (-not $p) { Write-Fail "could not start VS Admin.exe" }
$p.Id | Set-Content -Path $PidFile -Encoding ascii

Start-Sleep -Milliseconds 800
Write-Host "VS ADMIN"
Write-Host "  SERVER       VS-CORE-01"
Write-Host "  SERVER API   CONNECTED"
Write-Host "  TRANSPORT    $transport"
Write-Host "  ADMIN        VS Admin.exe"
Write-Host "  UI           native window (no browser)"
Write-Host "STOP: powershell -File ADMIN\windows\stop-admin.ps1   (does not stop i3)"
exit 0
