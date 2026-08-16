#Requires -Version 5.1
$ErrorActionPreference = "Continue"
$PidFile = Join-Path $env:LOCALAPPDATA "VS\admin\control-panel.pid"

Write-Host "VS ADMIN STOP"

# Vite / node on 5173
try {
  $conns = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" }
  foreach ($c in @($conns)) {
    if ($c.OwningProcess) {
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
      Write-Host ("Stopped PID " + $c.OwningProcess + " (port 5173)")
    }
  }
} catch {
  # Fallback to pid file below
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
