@echo off
REM Emergency bootstrap — lejupielade VS.exe + VS.bat bez MINSIZE slazda
setlocal EnableExtensions
cd /d "%~dp0"
echo [GET] VS.exe + VS.bat no GitHub main...
curl.exe -fL --retry 5 -o "%CD%\VS.exe.new" "https://github.com/voldis1994/VS/raw/refs/heads/main/VS.exe"
if not exist "%CD%\VS.exe.new" (
  curl.exe -fL --retry 5 -o "%CD%\VS.exe.new" "https://raw.githubusercontent.com/voldis1994/VS/main/VS.exe"
)
if not exist "%CD%\VS.exe.new" (
  echo FAIL — nevar lejupieladet VS.exe
  pause
  exit /b 1
)
for %%A in ("%CD%\VS.exe.new") do echo bytes=%%~zA
taskkill /F /T /IM VS.exe >nul 2>&1
timeout /t 2 /nobreak >nul
del /f /q "%CD%\VS.exe" >nul 2>&1
move /Y "%CD%\VS.exe.new" "%CD%\VS.exe" >nul
curl.exe -fL --retry 3 -o "%CD%\VS.bat" "https://raw.githubusercontent.com/voldis1994/VS/main/VS.bat"
powershell -NoProfile -Command "try{Unblock-File -LiteralPath '%CD%\VS.exe'}catch{}"
echo [OK] palaizu VS.exe ...
start "" "%CD%\VS.exe" "%CD%"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:18090"
echo Panelis: http://127.0.0.1:18090  — LAUNCHER jabut bridge75a0
pause
