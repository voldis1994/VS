# Market Reader

Real-time multi-source market intelligence engine for event-driven scalping (~10 second horizon).

## What This Is

Market Reader is **not** an RSI/EMA/MACD bot. It is a layered system that:

1. Ingests multi-source market data (tick, quote, trade, order-book)
2. Normalizes timestamps and assesses data quality
3. Fuses multiple feeds with lead/lag analysis
4. Computes incremental features on rolling windows (10ms–60s)
5. Builds structured Market State snapshots
6. Classifies market regimes
7. Discovers setup hypotheses
8. Accumulates sequential evidence
9. Generates explainable TradeIntents with EV calculation
10. Routes execution to multiple broker accounts
11. Manages positions independently via Exit Engine

## Architecture

```
MARKET DATA → INGESTION → NORMALIZATION → DATA QUALITY → FEED FUSION
  → FEATURE ENGINE → MARKET STATE → REGIME → SETUP → EVIDENCE
  → ENTRY → EXECUTION ROUTER → BROKER → POSITION MANAGER → EXIT
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

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

Lejupielādē jaunāko `main`, palaiž sistēmu, **šajā logā** parāda klienta `https://….trycloudflare.com` saiti.  
Admin: `http://localhost:5173/` · Klienta panelis lokāli: `http://127.0.0.1:18080`

**DuckDNS (fiksēts nosaukums, bez Cloudflare):** `VS-DUCKDNS.bat` → `http://vs-system.duckdns.org:18080`  
Skatīt [docs/CLIENT_PANEL_DUCKDNS.md](docs/CLIENT_PANEL_DUCKDNS.md). Atpakaļ uz Cloudflare: `VS-CLOUDFLARE.bat`.
Neaizver to logu. Admin: http://localhost:5173/

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
VS.bat              one-click launcher (git pull, stack, Cloudflare tunnel)
VS-DUCKDNS.bat      same stack + DuckDNS public URL (no Cloudflare)
VS-CLOUDFLARE.bat   switch share mode back to Cloudflare tunnel
```

## Security

- API credentials encrypted at rest (AES-256-GCM)
- Secrets never in frontend, git, or plaintext DB
- Masked credential display in dashboard
- Admin token required for API (production)

## License

Proprietary. All rights reserved.
