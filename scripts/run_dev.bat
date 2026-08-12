@echo off
start "Market Core" cmd /c "build\windows-debug\apps\market-core\market-core.exe --mode PAPER"
timeout /t 2 /nobreak >nul
start "Execution Service" cmd /c "build\windows-debug\apps\execution-service\execution-service.exe --mode PAPER"
timeout /t 2 /nobreak >nul
start "Control API" cmd /c "cd apps\control-api && npm run dev"
timeout /t 3 /nobreak >nul
start "Dashboard" cmd /c "cd apps\dashboard && npm run dev"
echo Development stack started.
echo Dashboard: http://localhost:5173
echo API: http://localhost:3000
exit /b 0
