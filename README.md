# Market Reader / VS

Real-time multi-source market intelligence + VS SERVER trading appliance.

## Product boundaries

```
VS/
├── SERVER/     # Authoritative brain (i3) — INSTALL_I3_SERVER
├── ADMIN/      # Control Panel + diagnostic client (MSI PC)
└── CLIENT/     # Device app build — BUILD_CLIENT (native UI deferred)
```

Money path lives under `SERVER/control-api` (verified P0). Compatibility symlinks:
`apps/control-api` → `SERVER/control-api`, `deploy/vs-core` → `SERVER/deploy`.

**LIVE trading stays fail-closed** (`LIVE_TRADING_ENABLED=false`) until Capital DEMO + production gates are satisfied on real hardware.

## Clean install (Debian i3 SERVER)

```bash
sudo bash SERVER/INSTALL_I3_SERVER
sudo bash SERVER/STATUS_SERVER
```

MSI Control Panel:
```bash
export VS_SERVER_URL=http://192.168.0.53:3000   # your i3 LAN IP
bash ADMIN/INSTALL_CONTROL_PANEL
# edit ADMIN/config/control-panel.env → API_ADMIN_TOKEN
bash ADMIN/START_CONTROL_PANEL
```

See [START_3_FILES.txt](START_3_FILES.txt).

## Architecture

```
MARKET DATA → INGESTION → NORMALIZATION → DATA QUALITY → FEED FUSION
  → FEATURE ENGINE → MARKET STATE → REGIME → SETUP → EVIDENCE
  → ENTRY → EXECUTION ROUTER → BROKER → POSITION MANAGER → EXIT
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/VS_ARCHITECTURE_INVENTORY.md](docs/VS_ARCHITECTURE_INVENTORY.md).

## Prerequisites

### Windows 11 x64
- Git
- Visual Studio 2022 Build Tools (C++ workload)
- CMake 3.24+
- Node.js 20+
- Docker Desktop
- vcpkg (used by CMake if `market-core.exe` is missing on first `VS.bat` run)

### Linux (development/CI)
- GCC 13+ or Clang 16+
- CMake, Ninja
- Node.js 20+
- Docker
- Development libraries: fmt, spdlog, yaml-cpp, nlohmann-json, openssl, curl, gtest, zlib (optional: Google Benchmark via `vcpkg` feature `benchmarks`)

## Quick Start (Windows)

**Vienīgais fails — dubultklikšķis:**

```bat
VS.bat
```

Atver **VS paneli** (`http://127.0.0.1:18090`). Viena poga palaiž / restartē sistēmu no GitHub.  
Neaizver to paneli. Admin: http://localhost:5173/

Skatīt [docs/VS_RESTART.md](docs/VS_RESTART.md).

## Build

```bat
cmake --preset windows-debug
cmake --build build/windows-debug
```

Linux:
```bash
cmake --preset linux-debug
cmake --build build/linux-debug
```

## Operating Modes

| Mode | Description |
|------|-------------|
| REPLAY | Deterministic playback of recorded events |
| PAPER | Simulated execution (default) |
| DEMO | Broker demo environment |
| LIVE | Real trading (disabled by default) |

Enable LIVE:
```
LIVE_TRADING_ENABLED=true
OPERATING_MODE=LIVE
```

## Run

```bat
VS.bat
```

Backend tests:
```bash
cd apps/control-api && npm test
```

## Project Structure

```
apps/           market-core, execution-service, control-api, dashboard
libs/           C++ engine libraries (clock, features, regime, evidence, etc.)
config/         YAML configuration
data/           raw, normalized, replay recordings
tests/          unit, integration, replay, execution, security, performance
docs/           architecture and operations documentation
VS.bat          one-click launcher (git pull, stack, client tunnel)
```

## Security

- API credentials encrypted at rest (AES-256-GCM)
- Secrets never in frontend, git, or plaintext DB
- Masked credential display in dashboard
- Admin token required for API (production)

## License

Proprietary. All rights reserved.
