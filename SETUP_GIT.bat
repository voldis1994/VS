@echo off
REM One-time: turn C:\VS-main (or C:\VS) into a git clone so git pull works.
setlocal EnableExtensions
cd /d "%~dp0"

echo ########################################
echo #  VS - SETUP GIT
echo ########################################

where git >nul 2>&1
if errorlevel 1 (
  echo FAIL: install Git for Windows first
  echo https://git-scm.com/download/win
  pause
  exit /b 1
)

if exist "%~dp0.git" (
  echo OK: already a git repo
  git remote -v
  git status -sb
  pause
  exit /b 0
)

echo This folder has NO .git - it was copied/unzipped, not cloned.
echo.
echo Option A - RECOMMENDED: fresh clone to C:\VS
echo   cd /d C:\
echo   rmdir /s /q C:\VS-main
echo   git clone https://github.com/voldis1994/VS C:\VS
echo   cd C:\VS
echo   REBUILD_ALL.bat
echo.
echo Option B - init git HERE and pull main into this folder:
set /p PICK="Type A to exit and clone manually, or B to init here: "
if /I not "%PICK%"=="B" (
  echo Exit and use Option A above.
  pause
  exit /b 0
)

git init
git remote add origin https://github.com/voldis1994/VS.git
git fetch origin main
git checkout -b main
git reset --hard origin/main
if errorlevel 1 (
  echo FAIL: could not sync with origin/main
  pause
  exit /b 1
)

echo.
echo OK - now a git repo on origin/main
git log -1 --oneline
echo Run REBUILD_ALL.bat next.
pause
exit /b 0
