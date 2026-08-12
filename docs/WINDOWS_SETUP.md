# Windows 11 Setup

Target platform: Windows 11 x64. Use the automated bootstrap script as the primary path.

## Prerequisites

| Tool | Notes |
|------|--------|
| Git | Required |
| Visual Studio 2022 Build Tools | C++ workload (`cl.exe` on PATH) |
| CMake 3.24+ | Presets in `CMakePresets.json` |
| Node.js 20+ | control-api + dashboard |
| Docker Desktop | Postgres + Redis |
| PowerShell | Built-in |
| vcpkg | Bootstrapped by setup if missing |

Suggested installs via winget:

```bat
winget install Git.Git
winget install Kitware.CMake
winget install OpenJS.NodeJS.LTS
winget install Docker.DockerDesktop
winget install Microsoft.VisualStudio.2022.BuildTools
```

## Run setup

From the repository root:

```bat
scripts\setup_windows.bat
```

The script:

1. Checks Git, CMake, Node, npm, Docker, PowerShell, and MSVC (`cl`).
2. Sets or bootstraps `VCPKG_ROOT` (`%USERPROFILE%\vcpkg` if unset).
3. Copies `.env.example` → `.env` when `.env` is absent (never overwrites).
4. Runs `vcpkg install --triplet x64-windows`.
5. Configures and builds **windows-debug** and **windows-release** CMake presets.
6. Runs `npm install` in `apps\control-api` and `apps\dashboard`.
7. Starts `docker compose up -d postgres redis`.
8. Runs control-api migrations (`npm run migrate`).
9. Executes `ctest` in `build\windows-debug`.

Exit code is the count of failed steps. Fix reported `[MISSING]` tools and re-run.

## After setup

```bat
scripts\run_dev.bat
```

- Dashboard: http://localhost:5173  
- Control API: http://localhost:3000  

Other entry points:

| Script | Purpose |
|--------|---------|
| `scripts\run_paper.bat` | Paper market-core + execution-service |
| `scripts\run_replay.bat <file.mrev>` | Deterministic replay |
| `scripts\run_demo.bat` | Demo mode |
| `scripts\run_live.bat` | Live (requires `LIVE_TRADING_ENABLED=true`) |
| `scripts\doctor.bat` | Prerequisite / build health check |
| `scripts\test.bat` | Rebuild debug + ctest |
| `scripts\stop.bat` | Kill core processes, stop compose |

## Manual build (optional)

```bat
cmake --preset windows-debug
cmake --build build/windows-debug --config Debug

cmake --preset windows-release
cmake --build build/windows-release --config Release
```

## Environment

Edit `.env` after first copy:

- Set `MASTER_ENCRYPTION_KEY`, `API_ADMIN_TOKEN`, DB password.
- Keep `LIVE_TRADING_ENABLED=false` until credentials and risk controls are verified.
- Ensure Docker Desktop is running before compose/migrate steps.
