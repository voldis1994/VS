@echo off
REM Switch back to Cloudflare tunnel share (disconnect DuckDNS public mode)
setlocal EnableExtensions
cd /d "%~dp0"
set "ROOT=%CD%"

if not exist "%ROOT%\.env" (
  if exist "%ROOT%\.env.example" copy /Y "%ROOT%\.env.example" "%ROOT%\.env" >nul
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%~dp0.env'; if (-not (Test-Path -LiteralPath $p)) { exit 0 };" ^
  "$c=Get-Content -LiteralPath $p -Raw; if ($null -eq $c) { $c='' };" ^
  "if ($c -match '(?m)^PUBLIC_SHARE_MODE=') { $c=[regex]::Replace($c,'(?m)^PUBLIC_SHARE_MODE=.*','PUBLIC_SHARE_MODE=cloudflare') } else { if ($c.Length -gt 0 -and -not $c.EndsWith(\"`n\")) { $c+=\"`r`n\" }; $c+=\"PUBLIC_SHARE_MODE=cloudflare`r`n\" };" ^
  "Set-Content -LiteralPath $p -Value $c -NoNewline"

echo [VS-CLOUDFLARE] PUBLIC_SHARE_MODE=cloudflare
echo [VS-CLOUDFLARE] Nakamais VS.bat atvers trycloudflare.com tuneli.
echo [VS-CLOUDFLARE] Ieteicams aizvert router port 18080, ja vairs nevajag.
echo.
call "%ROOT%\VS.bat"
exit /b %ERRORLEVEL%
