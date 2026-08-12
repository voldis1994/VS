@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
title VS - Share Client Panel (Internet)

echo.
echo =====================================================
echo   VS CLIENT PANEL - PUBLIC LINK FOR REMOTE CLIENTS
echo   (works when client is NOT on your Wi-Fi)
echo =====================================================
echo.
echo Prerequisites (keep these running):
echo   1^) Control API on port 3000
echo   2^) Client panel:  cd apps\dashboard ^&^& npm run dev:client
echo.
echo This script opens a FREE Cloudflare tunnel to port 5174
echo and prints an https://....trycloudflare.com URL.
echo Send THAT URL + access code to your client.
echo.

where cloudflared >nul 2>&1
if errorlevel 1 (
  echo cloudflared not found — trying npx...
  echo.
  where npm >nul 2>&1
  if errorlevel 1 (
    echo ERROR: Install Cloudflare Tunnel OR Node.js
    echo   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
    echo.
    pause
    exit /b 1
  )
  echo Starting tunnel via npx cloudflared...
  echo Leave this window open while the client uses the panel.
  echo.
  npx --yes cloudflared tunnel --url http://127.0.0.1:5174
  exit /b %ERRORLEVEL%
)

echo Starting cloudflared tunnel to http://127.0.0.1:5174 ...
echo Leave this window open while the client uses the panel.
echo.
cloudflared tunnel --url http://127.0.0.1:5174
exit /b %ERRORLEVEL%
