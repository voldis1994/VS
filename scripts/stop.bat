@echo off
taskkill /f /im market-core.exe 2>nul
taskkill /f /im execution-service.exe 2>nul
docker compose stop
echo Services stopped.
exit /b 0
