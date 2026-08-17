@echo off
REM Canonical Windows build for VS Admin.exe
REM   ADMIN\windows\BUILD_ADMIN.bat
REM Do not add BUILD_ADMIN_NEW.bat / BUILD_ADMIN_FINAL.bat / BUILD_V2.bat
setlocal EnableExtensions
cd /d "%~dp0..\.."

echo ########################################
echo #  VS ADMIN — BUILD_ADMIN
echo ########################################

if not exist "%CD%\ADMIN\desktop\main.py" (
  echo FAIL: not VS repo root. Use C:\VS-main
  echo cwd=%CD%
  exit /b 1
)

where python >nul 2>&1
if errorlevel 1 (
  echo FAIL: Python 3 is required. Install from https://www.python.org/downloads/
  echo Then re-run ADMIN\windows\BUILD_ADMIN.bat
  exit /b 1
)

python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)"
if errorlevel 1 (
  echo FAIL: Python 3.10+ required
  python --version
  exit /b 1
)

echo ==^> install locked dependencies
python -m pip install --upgrade pip
if errorlevel 1 exit /b 1
python -m pip install -r "%CD%\ADMIN\desktop\requirements-dev.txt"
if errorlevel 1 (
  python -m pip install -r "%CD%\ADMIN\desktop\requirements.txt" pytest pyinstaller
  if errorlevel 1 exit /b 1
)

echo ==^> tests
set QT_QPA_PLATFORM=offscreen
pushd "%CD%\ADMIN\desktop"
python -m pytest tests
set "TERR=%ERRORLEVEL%"
popd
if not "%TERR%"=="0" (
  echo FAIL: ADMIN desktop tests
  exit /b %TERR%
)

echo ==^> PyInstaller
if exist "%CD%\ADMIN\desktop\dist" rmdir /s /q "%CD%\ADMIN\desktop\dist"
pushd "%CD%\ADMIN\desktop"
python -m PyInstaller --noconfirm --clean vs_admin.spec
set "BERR=%ERRORLEVEL%"
popd
if not "%BERR%"=="0" (
  echo FAIL: PyInstaller
  exit /b %BERR%
)

if not exist "%CD%\ADMIN\windows\dist" mkdir "%CD%\ADMIN\windows\dist"
copy /Y "%CD%\ADMIN\desktop\dist\VS Admin.exe" "%CD%\ADMIN\windows\dist\VS Admin.exe"
if errorlevel 1 (
  echo FAIL: VS Admin.exe was not produced
  dir /b "%CD%\ADMIN\desktop\dist"
  exit /b 1
)

echo ==^> validate executable exists
if not exist "%CD%\ADMIN\windows\dist\VS Admin.exe" (
  echo FAIL: missing ADMIN\windows\dist\VS Admin.exe
  exit /b 1
)

echo ########################################
echo #  BUILD OK
echo #  ARTIFACT  ADMIN\windows\dist\VS Admin.exe
echo #  START     START_MSI.bat
echo ########################################
exit /b 0
