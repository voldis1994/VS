#Requires -Version 5.1
# MSI one-shot: start native VS Admin.exe (same as START_MSI.bat).
$ErrorActionPreference = "Stop"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "start-admin.ps1")
exit $LASTEXITCODE
