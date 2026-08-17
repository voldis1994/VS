@echo off
REM FINAL_ACCEPTANCE.bat — remote client acceptance entry
setlocal
cd /d "%~dp0"
call "%~dp0VERIFY_CLIENT.bat"
exit /b %ERRORLEVEL%
