@echo off
REM Convenience: force DuckDNS share mode, then run VS.bat
setlocal EnableExtensions
cd /d "%~dp0"
set "ROOT=%CD%"

if not exist "%ROOT%\.env" (
  if exist "%ROOT%\.env.example" copy /Y "%ROOT%\.env.example" "%ROOT%\.env" >nul
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%~dp0.env'; $pairs=@{PUBLIC_SHARE_MODE='duckdns'; DUCKDNS_DOMAIN='vs-system.duckdns.org'; CLIENT_COOKIE_SECURE='false'; VITE_CLIENT_PANEL_URL='http://vs-system.duckdns.org:18080'};" ^
  "if (-not (Test-Path -LiteralPath $p)) { '' | Set-Content -LiteralPath $p };" ^
  "$c=Get-Content -LiteralPath $p -Raw; if ($null -eq $c) { $c='' };" ^
  "foreach ($k in $pairs.Keys) { $v=$pairs[$k]; if ($c -match ('(?m)^'+[regex]::Escape($k)+'=')) { $c=[regex]::Replace($c,('(?m)^'+[regex]::Escape($k)+'=.*'),($k+'='+$v)) } else { if ($c.Length -gt 0 -and -not $c.EndsWith(\"`n\")) { $c+=\"`r`n\" }; $c+=($k+'='+$v+\"`r`n\") } };" ^
  "if ($c -notmatch '(?m)^CLIENT_CORS_ORIGIN=') { $c+=\"CLIENT_CORS_ORIGIN=http://localhost:5173,http://localhost:5174,http://127.0.0.1:18080,http://vs-system.duckdns.org:18080`r`n\" } else { $c=[regex]::Replace($c,'(?m)^CLIENT_CORS_ORIGIN=.*','CLIENT_CORS_ORIGIN=http://localhost:5173,http://localhost:5174,http://127.0.0.1:18080,http://vs-system.duckdns.org:18080') };" ^
  "Set-Content -LiteralPath $p -Value $c -NoNewline"

echo.
echo [VS-DUCKDNS] PUBLIC_SHARE_MODE=duckdns
echo [VS-DUCKDNS] URL = http://vs-system.duckdns.org:18080
echo [VS-DUCKDNS] Ieliec DUCKDNS_TOKEN=.env no https://www.duckdns.org
echo [VS-DUCKDNS] Router: 18080 -^> PC :18080   Docs: docs\CLIENT_PANEL_DUCKDNS.md
echo.
REM Use local VS.bat body (includes DuckDNS share) even before GitHub main has it
set "VS_USE_LOCAL_BAT=1"
call "%ROOT%\VS.bat"
exit /b %ERRORLEVEL%
