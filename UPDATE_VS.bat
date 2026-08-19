@echo off
REM Update existing C:\VS git clone and rebuild
setlocal EnableExtensions

if exist "C:\VS\.git" (
  cd /d C:\VS
  goto :run
)
if exist "C:\VS-main\.git" (
  cd /d C:\VS-main
  goto :run
)
if exist "C:\VS-main\START_MSI.bat" (
  cd /d C:\VS-main
  goto :run
)
if exist "C:\VS\START_MSI.bat" (
  cd /d C:\VS
  goto :run
)

echo FAIL: neither C:\VS nor C:\VS-main found
pause
exit /b 1

:run
echo Using %CD%
if exist ".git" (
  git pull origin main
  git log -1 --oneline
) else (
  echo No .git - run SETUP_GIT.bat or clone fresh to C:\VS
)
call REBUILD_ALL.bat
