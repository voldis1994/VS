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

## Deployment — three machines

### [i3 SERVER] — VS-CORE-01

```bash
git clone https://github.com/voldis1994/VS.git /root/VS
cd /root/VS
sudo bash SERVER/INSTALL_I3_SERVER
sudo bash SERVER/STATUS_SERVER
```

Postgres, Redis, Control API, trading backend, WireGuard, and enrollment stay on the i3 only.

### [MSI WINDOWS ADMIN] — Control Panel (not the server)

```bat
cd ADMIN
INSTALL_ADMIN.bat
START_ADMIN.bat
```

Requires Node.js 20+ and `API_ADMIN_TOKEN` once (file `ADMIN_TOKEN.txt` or from i3 `server.env`).  
Discovers VS-CORE-01 on LAN automatically. Opens http://127.0.0.1:5173 against the real i3 API.  
If the server is down, UI shows **SERVER OFFLINE** — no mock READY.

Linux admin workstation: `bash ADMIN/INSTALL_ADMIN` then `bash ADMIN/START_ADMIN`.

### [REMOTE CLIENT]

1. On MSI → Control Panel → **NETWORK** → create CLIENT enrollment.
2. On the client PC: complete enrollment (local keypair); import WireGuard peer config.
3. Router: forward UDP **51820** to i3. Clients use private `10.77.0.1` — any ISP/NAT.

See [START_3_FILES.txt](START_3_FILES.txt).

## Architecture

```
MARKET DATA → INGESTION → NORMALIZATION → DATA QUALITY → FEED FUSION
  → FEATURE ENGINE → MARKET STATE → REGIME → SETUP → EVIDENCE
  → ENTRY → EXECUTION ROUTER → BROKER → POSITION MANAGER → EXIT
```

```
REMOTE CLIENT ──(Internet / WireGuard)──► i3 VS-CORE-01 ──► authenticated VS API
MSI ADMIN     ──(home LAN or WireGuard)──► i3 VS-CORE-01 ──► admin API + snapshot
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/VS_ARCHITECTURE_INVENTORY.md](docs/VS_ARCHITECTURE_INVENTORY.md).

## Prerequisites

### Windows 11 x64 (MSI ADMIN)
- Git
- Node.js 20+
- (Optional) WireGuard for off-LAN admin

### Windows 11 x64 (optional full local market-core build)
- Visual Studio 2022 Build Tools (C++ workload)
- CMake 3.24+
- Docker Desktop
- vcpkg (used by CMake if `market-core.exe` is missing on first `VS.bat` run)

### Linux (i3 SERVER / CI)
- GCC 13+ or Clang 16+
- CMake, Ninja
- Node.js 20+
- Docker
- Development libraries: fmt, spdlog, yaml-cpp, nlohmann-json, openssl, curl, gtest, zlib (optional: Google Benchmark via `vcpkg` feature `benchmarks`)

## Quick Start (legacy single-PC Windows)

**Vienīgais fails — dubultklikšķis:**

```bat
VS.bat
```

Atver **VS paneli** (`http://127.0.0.1:18090`). Viena poga palaiž / restartē sistēmu no GitHub.  
Neaizver to paneli. Admin: http://localhost:5173/

For **production multi-PC**, use the three-machine section above — do not run the server on the MSI.

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

ADMIN client tests:
```bash
cd ADMIN && npm test
```

## Project Structure

```
apps/           market-core, execution-service, control-api, dashboard
libs/           C++ engine libraries (clock, features, regime, evidence, etc.)
config/         YAML configuration
SERVER/         i3 appliance install + control-api source of truth
ADMIN/          MSI Control Panel (INSTALL_ADMIN.bat / START_ADMIN.bat)
CLIENT/         remote client package / enrollment foundation
data/           raw, normalized, replay recordings
tests/          unit, integration, replay, execution, security, performance
docs/           architecture and operations documentation
VS.bat          legacy single-PC launcher (not the multi-PC production path)
```
## Security

- API credentials encrypted at rest (AES-256-GCM)
- Secrets never in frontend, git, or plaintext DB
- Masked credential display in dashboard
- Admin token required for API (production)

## License

Proprietary. All rights reserved.
