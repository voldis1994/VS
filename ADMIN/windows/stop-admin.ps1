#Requires -Version 5.1
$ErrorActionPreference = "Continue"
$PidFile = Join-Path $env:LOCALAPPDATA "VS\admin\control-panel.pid"

Write-Host "VS ADMIN STOP — killing canonical UI (:5188) and any stale tactical (:5173)"

foreach ($Port in @(5188, 5173)) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
      Where-Object { $_.State -eq "Listen" }
    foreach ($c in @($conns)) {
      if ($c.OwningProcess) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host ("Stopped PID " + $c.OwningProcess + " (port " + $Port + ")")
      }
    }
  } catch { }
}

if (Test-Path $PidFile) {
  $old = Get-Content $PidFile -ErrorAction SilentlyContinue
  if ($old) {
    Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue
    Write-Host ("Stopped PID " + $old + " (pid file)")
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Write-Host "SUCCESS: Control Panel stopped (or was not running)"
exit 0
