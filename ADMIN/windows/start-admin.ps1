#Requires -Version 5.1
<#
.SYNOPSIS
  Start ONLY canonical VS ADMIN desktop (ADMIN/desktop) against i3 VS-CORE-01.
  Never starts legacy-review / tactical dashboard.
#>

$ErrorActionPreference = "Continue"
$AdminRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $AdminRoot
$Dash = Join-Path $AdminRoot "desktop"
$Cfg = Join-Path $AdminRoot "config\control-panel.env"
$PidFile = Join-Path $env:LOCALAPPDATA "VS\admin\control-panel.pid"
$UiPort = 5188
Set-Location $AdminRoot

function Write-Fail([string]$Msg) {
  Write-Host ("FAIL: " + $Msg)
  exit 1
}

function Test-VsHealth([string]$Url) {
  if (-not $Url) { return $false }
  $u = $Url.TrimEnd("/")
  try {
    $r = Invoke-WebRequest -Uri ($u + "/health") -UseBasicParsing -TimeoutSec 4
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Get-CfgValue([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) { return $null }
  foreach ($line in Get-Content $Path) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $i = $t.IndexOf("=")
    if ($i -lt 1) { continue }
    if ($t.Substring(0, $i).Trim() -eq $Key) {
      return $t.Substring($i + 1).Trim()
    }
  }
  return $null
}

function Stop-PortListeners([int]$Port) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
      Where-Object { $_.State -eq "Listen" }
    foreach ($c in @($conns)) {
      if ($c.OwningProcess) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host ("Stopped stale PID " + $c.OwningProcess + " on port " + $Port)
      }
    }
  } catch { }
}

# --- Canonical UI hard checks ---
$Pkg = Join-Path $Dash "package.json"
$Index = Join-Path $Dash "index.html"
if (-not (Test-Path $Pkg)) { Write-Fail "ADMIN/desktop missing — run INSTALL_ADMIN.bat" }
$pkgJson = Get-Content $Pkg -Raw
if ($pkgJson -notmatch '"name"\s*:\s*"@vs/admin-desktop"') {
  Write-Fail "ADMIN/desktop/package.json is not @vs/admin-desktop (wrong UI tree)"
}
if (-not (Test-Path $Index)) { Write-Fail "ADMIN/desktop/index.html missing" }
$idx = Get-Content $Index -Raw
if ($idx -notmatch '<title>VS ADMIN</title>') {
  Write-Fail "ADMIN/desktop/index.html title must be VS ADMIN"
}
if ($idx -match 'TACTICAL|VS SYSTEM') {
  Write-Fail "ADMIN/desktop contains legacy tactical markers"
}

# Refuse to start if someone points at archived dashboard
if ((Get-Location).Path -like "*legacy-review*") {
  Write-Fail "CWD is under legacy-review — production START refuses"
}

if (-not (Test-Path (Join-Path $Dash "node_modules"))) {
  Write-Fail "run INSTALL_ADMIN.bat first (desktop node_modules missing)"
}
if (-not (Test-Path $Cfg)) {
  Write-Fail "missing config\control-panel.env - run INSTALL_ADMIN.bat first"
}

# Load tokens / prior config
Get-Content $Cfg | ForEach-Object {
  $line = $_.Trim()
  if (-not $line) { return }
  if ($line.StartsWith("#")) { return }
  $i = $line.IndexOf("=")
  if ($i -lt 1) { return }
  $k = $line.Substring(0, $i).Trim()
  $v = $line.Substring($i + 1).Trim()
  Set-Item -Path ("Env:" + $k) -Value $v
}

function Test-VsCoreIdentity([string]$Url) {
  if (-not $Url) { return $false }
  $u = $Url.TrimEnd("/")
  $health = $u + "/health"
  $tmp = Join-Path $env:TEMP ("vs-health-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
      # MUST write to file — PS 5.1 breaks curl.exe stdout capture (false negatives)
      & curl.exe -sS --connect-timeout 5 --max-time 8 -o $tmp $health 2>"$tmp.err"
      if (-not (Test-Path $tmp)) { return $false }
      $raw = [System.IO.File]::ReadAllText($tmp)
    } else {
      $r = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -lt 200 -or $r.StatusCode -ge 300) { return $false }
      $raw = [string]$r.Content
    }
    if ([string]::IsNullOrWhiteSpace($raw)) { return $false }
    # Regex — avoid ConvertFrom-Json quirks on PS 5.1
    if ($raw -notmatch '"service"\s*:\s*"VS-CORE"') { return $false }
    if ($raw -notmatch '"server_id"\s*:\s*"[^"]+"') { return $false }
    return $true
  } catch {
    return $false
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Remove-Item ($tmp + ".err") -ErrorAction SilentlyContinue
  }
}

function Show-ProbeDetail([string]$Url) {
  $health = $Url.TrimEnd("/") + "/health"
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    Write-Host ("  detail " + $health)
    & curl.exe -sS -o NUL -w "  HTTP %{http_code} time=%{time_total}s err=%{errormsg}\n" --connect-timeout 3 --max-time 5 $health 2>&1 | ForEach-Object { Write-Host $_ }
  }
}

function Get-LocalLanProbeUrls {
  $list = New-Object System.Collections.Generic.List[string]
  try {
    $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        $_.IPAddress -notlike "10.77.*" -and
        # Skip Docker / Hyper-V / WSL NAT bridges (172.16-31.x) — not home LAN to i3
        $_.IPAddress -notmatch '^172\.(1[6-9]|2[0-9]|3[0-1])\.' -and
        # Skip Tailscale CGNAT
        $_.IPAddress -notmatch '^100\.'
      }
    foreach ($a in @($addrs)) {
      $parts = $a.IPAddress.Split(".")
      if ($parts.Count -eq 4) {
        $prefix = $parts[0] + "." + $parts[1] + "." + $parts[2]
        # Prefer common router/AP/server hosts only — short list, not a scan of the subnet
        foreach ($hostOct in @(1, 2, 10, 20, 50, 53, 100, 101, 200)) {
          [void]$list.Add("http://${prefix}.${hostOct}:3000")
        }
      }
    }
  } catch { }
  return $list
}

function Resolve-LanServerUrl {
  $candidates = New-Object System.Collections.Generic.List[string]
  # 1) Explicit saved / env (highest priority)
  foreach ($k in @("VS_SERVER_URL", "VITE_API_URL", "VS_LAN_SERVER_URL")) {
    $v = Get-CfgValue $Cfg $k
    if ($v -and $v -notmatch '10\.77\.') { [void]$candidates.Add($v.TrimEnd("/")) }
  }
  if ($env:VS_SERVER_URL -and $env:VS_SERVER_URL -notmatch '10\.77\.') {
    [void]$candidates.Add($env:VS_SERVER_URL.TrimEnd("/"))
  }
  $ipFile = Join-Path $AdminRoot "config\SERVER_IP.txt"
  if (Test-Path $ipFile) {
    $manualIp = (Get-Content -LiteralPath $ipFile -TotalCount 1 -ErrorAction SilentlyContinue)
    if ($manualIp) {
      $manualIp = $manualIp.Trim()
      if ($manualIp -match '^\d+\.\d+\.\d+\.\d+$') {
        [void]$candidates.Add("http://${manualIp}:3000")
      }
    }
  }
  # 2) Known home LAN defaults
  foreach ($c in @(
      "http://192.168.0.10:3000",
      "http://192.168.0.53:3000",
      "http://192.168.1.10:3000"
    )) {
    [void]$candidates.Add($c)
  }
  # 3) Controlled local subnet probe (no Docker 172.x)
  foreach ($c in (Get-LocalLanProbeUrls)) { [void]$candidates.Add($c) }

  $seen = @{}
  $n = 0
  foreach ($c in $candidates) {
    if (-not $c) { continue }
    if ($seen.ContainsKey($c)) { continue }
    $seen[$c] = $true
    $n++
    if ($n -le 12) {
      Write-Host ("  probe " + $c + " ...")
    } elseif ($n -eq 13) {
      Write-Host "  ... probing remaining LAN candidates silently ..."
    }
    if (Test-VsCoreIdentity $c) {
      Write-Host ("  OK VS-CORE at " + $c)
      return $c
    }
  }
  return $null
}

Write-Host "========================================"
Write-Host " VS ADMIN — CANONICAL DESKTOP ONLY"
Write-Host " UI PATH = ADMIN\desktop"
Write-Host " UI PORT = $UiPort  (old tactical :5173 is killed, never used)"
Write-Host "========================================"

Write-Host "MSI IPv4 (must share 192.168.0.x with i3 for LAN):"
try {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" } |
    ForEach-Object { Write-Host ("  " + $_.IPAddress + "  " + $_.InterfaceAlias) }
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
    Write-Host "WARN: FORCE URL identity failed — falling back to discovery"
  }
}

if (-not $serverUrl) {
  Write-Host "Resolving VS-CORE-01 on LAN..."
  $serverUrl = Resolve-LanServerUrl
  $transport = "LAN"
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

$adminToken = $env:VITE_API_ADMIN_TOKEN
if (-not $adminToken) { $adminToken = $env:API_ADMIN_TOKEN }
if (-not $adminToken) { $adminToken = "" }

$env:VS_SERVER_URL = $serverUrl
$env:VITE_API_URL = $serverUrl
$env:VITE_WS_URL = ($serverUrl -replace '^http', 'ws') + "/ws"
$env:VS_ADMIN_TRANSPORT = $transport.ToLower()
$env:VITE_API_ADMIN_TOKEN = $adminToken
$env:API_ADMIN_TOKEN = $adminToken

# Persist config
$newLines = New-Object System.Collections.Generic.List[string]
$seenUrl = $false
Get-Content $Cfg | ForEach-Object {
  $row = $_
  if ($row -match '^\s*VS_SERVER_URL=') { [void]$newLines.Add("VS_SERVER_URL=$serverUrl"); $seenUrl = $true; return }
  if ($row -match '^\s*VITE_API_URL=') { [void]$newLines.Add("VITE_API_URL=$serverUrl"); return }
  if ($row -match '^\s*VITE_WS_URL=') { [void]$newLines.Add("VITE_WS_URL=$($env:VITE_WS_URL)"); return }
  if ($row -match '^\s*VS_ADMIN_TRANSPORT=') { [void]$newLines.Add("VS_ADMIN_TRANSPORT=$($transport.ToLower())"); return }
  if ($row -match '^\s*VS_LAN_SERVER_URL=') {
    if ($transport -eq "LAN") { [void]$newLines.Add("VS_LAN_SERVER_URL=$serverUrl") }
    return
  }
  [void]$newLines.Add($row)
}
if (-not $seenUrl) { [void]$newLines.Add("VS_SERVER_URL=$serverUrl") }
$newLines | Set-Content -Path $Cfg -Encoding ascii

# Runtime config for browser (localStorage bootstrap) — no secrets in git
$PublicDir = Join-Path $Dash "public"
New-Item -ItemType Directory -Force -Path $PublicDir | Out-Null
$runtime = @"
window.VS_ADMIN_RUNTIME = {
  product: "VS ADMIN",
  ui: "ADMIN/desktop",
  serverId: "VS-CORE-01",
  apiBase: "$serverUrl",
  adminToken: "$adminToken",
  transport: "$transport",
  deviceId: "VS-ADMIN-01",
  startedAt: "$(Get-Date -Format o)"
};
"@
# CRITICAL: no UTF-8 BOM — BOM breaks browser parse → falls back to 127.0.0.1:3000 → DISCONNECTED
$runtimePath = Join-Path $PublicDir "runtime-config.js"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($runtimePath, $runtime, $utf8NoBom)
Write-Host ("Wrote runtime-config.js apiBase=" + $serverUrl + " tokenLen=" + $adminToken.Length)

# Kill old tactical (:5173) and previous admin (:5188)
Stop-PortListeners 5173
Stop-PortListeners $UiPort
if (Test-Path $PidFile) {
  $old = Get-Content $PidFile -ErrorAction SilentlyContinue
  if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Write-Host "VS ADMIN"
Write-Host "  SERVER     = VS-CORE-01"
Write-Host "  TRANSPORT  = LAN"
Write-Host "  SERVER_URL = $serverUrl"
Write-Host "  UI         = http://127.0.0.1:$UiPort/"
Write-Host "  PRODUCT    = ADMIN/desktop (NOT tactical desk)"

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCmd) { Write-Fail "npm not found on PATH" }

Set-Location $Dash
$env:BROWSER = "none"

Start-Job -ScriptBlock {
  param($Port)
  Start-Sleep -Seconds 3
  Start-Process ("http://127.0.0.1:" + $Port + "/")
} -ArgumentList $UiPort | Out-Null

$p = Start-Process -FilePath $npmCmd.Source `
  -ArgumentList @("exec", "--", "vite", "--host", "127.0.0.1", "--port", "$UiPort", "--strictPort") `
  -WorkingDirectory $Dash `
  -PassThru `
  -NoNewWindow

if (-not $p) { Write-Fail "could not start vite for ADMIN/desktop" }
New-Item -ItemType Directory -Force -Path (Split-Path $PidFile) | Out-Null
$p.Id | Set-Content -Path $PidFile -Encoding ascii
Write-Host ("Control Panel PID=" + $p.Id + "  UI=http://127.0.0.1:$UiPort/")
Write-Host "STOP_ADMIN.bat or Ctrl+C to stop. Closing browser does not stop server on i3."

try {
  Wait-Process -Id $p.Id
  $code = 0
  if ($p.HasExited) { $code = $p.ExitCode }
  if ($null -eq $code) { $code = 0 }
  exit ([int]$code)
} finally {
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
