@echo off
REM =============================================================================
REM START_ADMIN.bat - start REAL Control Panel against i3 VS-CORE-01
REM Does NOT start Postgres/Redis/server backend on this PC.
REM =============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0windows\start-admin.ps1" (
  echo FAIL: missing windows\start-admin.ps1
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Resolve-Path '%~dp0windows\start-admin.ps1'; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$e); if ($e -and $e.Count -gt 0) { Write-Host 'FAIL: PowerShell parser error in windows\start-admin.ps1'; $e | ForEach-Object { Write-Host $_.ToString() }; exit 1 }; exit 0"
if errorlevel 1 (
  echo START FAILED - PowerShell helper has a syntax/parser error.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\start-admin.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo START FAILED
  pause
  exit /b %ERR%
)
exit /b 0
