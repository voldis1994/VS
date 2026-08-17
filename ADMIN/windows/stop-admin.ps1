#Requires -Version 5.1
# Stop only native VS Admin.exe. Never taskkill unrelated processes.
$ErrorActionPreference = "Continue"
$PidFile = Join-Path $env:LOCALAPPDATA "VS\admin\vs-admin.pid"

function Get-ProcessCommand([int]$ProcId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcId) -ErrorAction SilentlyContinue
    if ($p) { return [string]$p.CommandLine }
  } catch { }
  return ""
}

Write-Host "VS ADMIN STOP — native executable only"

$stopped = $false
if (Test-Path $PidFile) {
  $old = Get-Content $PidFile -ErrorAction SilentlyContinue
  if ($old) {
    $cmd = Get-ProcessCommand ([int]$old)
    if ($cmd -match 'VS Admin' -or $cmd -match 'ADMIN\\desktop\\main\.py' -or $cmd -eq "") {
      Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue
      Write-Host ("Stopped PID " + $old)
      $stopped = $true
    } else {
      Write-Host ("PID file " + $old + " is not VS ADMIN — not killed: " + $cmd)
    }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'VS Admin' -or ($_.CommandLine -and $_.CommandLine -match 'VS Admin\.exe') } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host ("Stopped PID " + $_.ProcessId)
    $stopped = $true
  }

if ($stopped) { Write-Host "SUCCESS: VS ADMIN stopped" } else { Write-Host "VS ADMIN was not running" }
exit 0
