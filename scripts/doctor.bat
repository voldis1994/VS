@echo off
echo === Market Reader Doctor ===
where git >nul 2>&1 && echo [OK] git || echo [FAIL] git
where cmake >nul 2>&1 && echo [OK] cmake || echo [FAIL] cmake
where cl >nul 2>&1 && echo [OK] msvc || echo [FAIL] msvc
where node >nul 2>&1 && echo [OK] node || echo [FAIL] node
where docker >nul 2>&1 && echo [OK] docker || echo [FAIL] docker
if defined VCPKG_ROOT (echo [OK] VCPKG_ROOT=%VCPKG_ROOT%) else (echo [WARN] VCPKG_ROOT not set)
if exist .env (echo [OK] .env exists) else (echo [WARN] .env missing)
if exist build\windows-debug\apps\market-core\market-core.exe (echo [OK] market-core built) else (echo [WARN] market-core not built)
docker compose ps 2>nul
exit /b 0
