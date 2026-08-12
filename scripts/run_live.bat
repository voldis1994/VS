@echo off
if not "%LIVE_TRADING_ENABLED%"=="true" (
    echo ERROR: LIVE_TRADING_ENABLED must be set to true
    exit /b 1
)
set OPERATING_MODE=LIVE
build\windows-release\apps\market-core\market-core.exe --mode LIVE
build\windows-release\apps\execution-service\execution-service.exe --mode LIVE
exit /b %ERRORLEVEL%
