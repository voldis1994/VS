#Requires -Version 5.1
# Stop local MSI stack: Control API + C++ calc + leftover native Admin. Does not drop Postgres data.
$ErrorActionPreference = "Continue"
$PidDir = Join-Path $env:LOCALAPPDATA "VS\admin"
$PidFile = Join-Path $PidDir "vs-api.pid"

Write-Host "VS STOP — local API + C++ calc (Postgres stays)"

function Stop-CmdMatch([string]$Pattern) {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $Pattern } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host ("Stopped PID " + $_.ProcessId)
    }
}

if (Test-Path $PidFile) {
  $old = Get-Content $PidFile -ErrorAction SilentlyContinue
  if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Stop-CmdMatch 'src\\index\.ts|control-api'
Stop-CmdMatch 'client-gateway\\gateway\.mjs'
Stop-CmdMatch 'vs-calc'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'VS Admin' -or $_.Name -match 'vs-calc' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "SUCCESS: local VS processes signaled to stop"
exit 0
