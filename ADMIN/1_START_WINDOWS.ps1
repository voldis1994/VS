#Requires -Version 5.1
<#
.SYNOPSIS
  Compatibility entry — ALWAYS starts canonical ADMIN/desktop via start-admin.ps1.
  Never starts the diagnostic CLI as the product UI.
  Never starts legacy-review tactical desk.
#>
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Redirecting to canonical VS ADMIN (ADMIN\desktop on :5188)..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "windows\start-admin.ps1")
exit $LASTEXITCODE
