# Windows 11 Setup

Target platform: Windows 11 x64.

## Start (only launcher)

From the repository root, double-click:

```bat
VS.bat
```

That one file:

1. Stops old VS processes
2. `git fetch` + `git reset --hard origin/main` (latest GitHub)
3. Starts Docker Postgres/Redis, `npm install`, migrations
4. Starts market-core (LIVE `--bridge`), execution-service, control-api, admin desk, client panel
5. Opens a Cloudflare tunnel to the client panel in **the same window**

Do not close the `VS.bat` window. Copy `https://….trycloudflare.com` plus the access code from http://localhost:5173/clients

## Prerequisites

| Tool | Notes |
|------|--------|
| Git | Required for GitHub update |
| Visual Studio 2022 Build Tools | C++ workload (`cl.exe`) — needed if `market-core.exe` is not built yet |
| CMake 3.24+ | Presets in `CMakePresets.json` |
| Node.js 20+ | control-api + dashboard |
| Docker Desktop | Postgres + Redis |
| PowerShell | Built-in |
| vcpkg | Optional; used when CMake configures C++ |

Suggested installs via winget:

```bat
winget install Git.Git
winget install Kitware.CMake
winget install OpenJS.NodeJS.LTS
winget install Docker.DockerDesktop
winget install Microsoft.VisualStudio.2022.BuildTools
```

## Manual C++ build (only if `VS.bat` warns that market-core.exe is missing)

```bat
cmake --preset windows-debug -DMR_BUILD_BENCHMARKS=OFF
cmake --build build/windows-debug --config Debug
```

Release:

```bat
cmake --preset windows-release
cmake --build build/windows-release --config Release
```

## Environment

Edit `.env` after first copy (VS.bat copies `.env.example` if `.env` is absent, and does not overwrite secrets):

- Set `MASTER_ENCRYPTION_KEY`, `API_ADMIN_TOKEN`, DB password, `PIPELINE_TOKEN`.
- `VS.bat` sets `OPERATING_MODE=LIVE` and `LIVE_TRADING_ENABLED=true`.
- Ensure Docker Desktop is running.
