@echo off
REM =============================================================================
REM STOP_ADMIN.bat - stop native VS Admin.exe on this Windows PC
REM =============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0windows\stop-admin.ps1" (
  echo FAIL: missing windows\stop-admin.ps1
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Resolve-Path '%~dp0windows\stop-admin.ps1'; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$e); if ($e -and $e.Count -gt 0) { Write-Host 'FAIL: PowerShell parser error in windows\stop-admin.ps1'; $e | ForEach-Object { Write-Host $_.ToString() }; exit 1 }; exit 0"
if errorlevel 1 exit /b 1

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\stop-admin.ps1"
exit /b %ERRORLEVEL%
