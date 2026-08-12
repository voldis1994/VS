@echo off
REM Kill all VS / Market Reader runtime windows and binaries.
setlocal EnableExtensions
cd /d "%~dp0.."

echo Stopping VS processes...

REM Window titles used by first_run / vs_restart_full
taskkill /F /FI "WINDOWTITLE eq MR-MarketCore*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq MR-Execution*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq MR-ControlAPI*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq MR-Dashboard*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq MR-ClientPanel*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq MR-ClientTunnel*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq VS - Share Client Panel*" >nul 2>&1

taskkill /F /IM market-core.exe >nul 2>&1
taskkill /F /IM execution-service.exe >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1

REM Node servers for control-api / vite (best-effort)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5173 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5174 " ^| findstr LISTENING') do taskkill /F /PID %%P >nul 2>&1

REM Keep Postgres/Redis data — only stop app processes by default
REM Uncomment to also stop DB containers:
REM docker compose stop >nul 2>&1

echo [OK] VS app processes stopped.
exit /b 0
