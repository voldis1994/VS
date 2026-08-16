@echo off
REM =============================================================================
REM STATUS_ADMIN.bat - connection status to i3 VS-CORE-01 (real health/snapshot)
REM =============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0windows\status-admin.ps1" (
  echo FAIL: missing windows\status-admin.ps1
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Resolve-Path '%~dp0windows\status-admin.ps1'; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$e); if ($e -and $e.Count -gt 0) { Write-Host 'FAIL: PowerShell parser error in windows\status-admin.ps1'; $e | ForEach-Object { Write-Host $_.ToString() }; exit 1 }; exit 0"
if errorlevel 1 (
  echo STATUS FAILED - PowerShell helper has a syntax/parser error.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\status-admin.ps1"
set "ERR=%ERRORLEVEL%"
pause
exit /b %ERR%
