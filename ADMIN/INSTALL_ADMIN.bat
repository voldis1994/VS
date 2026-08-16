@echo off
REM =============================================================================
REM INSTALL_ADMIN.bat - Windows MSI: install VS ADMIN Control Panel (not the server)
REM Double-click or run from Explorer. No Bash required.
REM =============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  VS ADMIN INSTALL (Windows)
echo ========================================

if not exist "%~dp0windows\install-admin.ps1" (
  echo FAIL: missing windows\install-admin.ps1
  pause
  exit /b 1
)

REM Fail immediately if PowerShell helper has a parser error (do not run broken script)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Resolve-Path '%~dp0windows\install-admin.ps1'; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$e); if ($e -and $e.Count -gt 0) { Write-Host 'FAIL: PowerShell parser error in windows\install-admin.ps1'; $e | ForEach-Object { Write-Host $_.ToString() }; exit 1 }; exit 0"
if errorlevel 1 (
  echo.
  echo INSTALL FAILED - PowerShell helper has a syntax/parser error.
  echo Fix ADMIN\windows\install-admin.ps1 before retrying.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\install-admin.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo INSTALL FAILED - see messages above.
  pause
  exit /b %ERR%
)
echo.
pause
exit /b 0
