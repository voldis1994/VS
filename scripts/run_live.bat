@echo off
REM LIVE mode — no gate checks (operator accepts risk)
set OPERATING_MODE=LIVE
set LIVE_TRADING_ENABLED=true
call "%~dp0run_market_core.bat" --mode LIVE %*
