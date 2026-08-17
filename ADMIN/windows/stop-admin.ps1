#Requires -Version 5.1
# Stop only VS ADMIN (serve-admin.mjs / recorded PID). Never taskkill node.exe.
$ErrorActionPreference = "Continue"
$PidFile = Join-Path $env:LOCALAPPDATA "VS\admin\control-panel.pid"
$UiPort = 5188

function Get-ListenPid([int]$Port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c -and $c.OwningProcess) { return [int]$c.OwningProcess }
  } catch { }
  return $null
}

function Get-ProcessCommand([int]$ProcId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcId) -ErrorAction SilentlyContinue
    if ($p) { return [string]$p.CommandLine }
  } catch { }
  return ""
}

Write-Host "VS ADMIN STOP — canonical UI only"

$stopped = $false
if (Test-Path $PidFile) {
  $old = Get-Content $PidFile -ErrorAction SilentlyContinue
  if ($old) {
    $cmd = Get-ProcessCommand ([int]$old)
    if ($cmd -match 'serve-admin\.mjs' -or $cmd -eq "") {
      Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue
      Write-Host ("Stopped PID " + $old + " (pid file)")
      $stopped = $true
    } else {
      Write-Host ("PID file " + $old + " is not VS ADMIN — not killed: " + $cmd)
    }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

$listen = Get-ListenPid $UiPort
if ($listen) {
  $cmd = Get-ProcessCommand $listen
  if ($cmd -match 'serve-admin\.mjs' -or $cmd -match 'VS_ADMIN_DIST') {
    Stop-Process -Id $listen -Force -ErrorAction SilentlyContinue
    Write-Host ("Stopped PID " + $listen + " (port 5188 VS ADMIN)")
    $stopped = $true
  } else {
    Write-Host "PORT 5188 OCCUPIED by foreign process — not killed"
    Write-Host ("PID " + $listen)
    Write-Host ("PROCESS " + $cmd)
    exit 1
  }
}

if ($stopped) { Write-Host "SUCCESS: VS ADMIN stopped" } else { Write-Host "VS ADMIN was not running" }
exit 0
