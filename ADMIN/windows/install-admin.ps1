#Requires -Version 5.1
<#
.SYNOPSIS
  Install / rebuild native VS ADMIN on Windows MSI.
  Canonical implementation is ADMIN\windows\BUILD_ADMIN.bat
#>
param(
  [switch]$Repair
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$bat = Join-Path $here "BUILD_ADMIN.bat"
if (-not (Test-Path $bat)) {
  Write-Host "FAIL: missing ADMIN\windows\BUILD_ADMIN.bat"
  exit 1
}
Write-Host "========================================"
if ($Repair) { Write-Host " VS ADMIN REPAIR — native VS Admin.exe" } else { Write-Host " VS ADMIN INSTALL — native VS Admin.exe" }
Write-Host " NEVER = Vite / localhost web UI / browser wrapper"
Write-Host "========================================"
$p = Start-Process -FilePath $bat -Wait -PassThru -NoNewWindow
exit $p.ExitCode
