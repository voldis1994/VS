@echo off
REM Build SUPER C++ calc (multi-TF + pressure + 200-bar polarity).
REM Hands stay in Node robotDesk — C++ only posts EntryReady.
REM Do not delete a shipped vs-calc.exe before compile — MSI often has no g++.
cd /d "%~dp0"
where g++ >nul 2>&1
if not errorlevel 1 (
  g++ -std=c++17 -O2 vs-calc.cpp -o vs-calc.exe
  if errorlevel 1 exit /b 1
  vs-calc.exe --self-test
  if errorlevel 1 exit /b 1
  echo OK vs-calc.exe SUPER
  exit /b 0
)
where cl >nul 2>&1
if not errorlevel 1 (
  cl /nologo /EHsc /std:c++17 /O2 vs-calc.cpp /Fe:vs-calc.exe
  if errorlevel 1 exit /b 1
  vs-calc.exe --self-test
  if errorlevel 1 exit /b 1
  echo OK vs-calc.exe SUPER
  exit /b 0
)
if exist vs-calc.exe (
  echo OK using shipped vs-calc.exe
  exit /b 0
)
echo FAIL: install MinGW g++ or MSVC cl.exe to build C++ calc
exit /b 1
