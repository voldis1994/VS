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
- vcpkg (bootstrapped by `START_HERE.bat`)

### Linux (development/CI)
- GCC 13+ or Clang 16+
- CMake, Ninja
- Node.js 20+
- Docker
- Development libraries: fmt, spdlog, yaml-cpp, nlohmann-json, openssl, curl, gtest, zlib (optional: Google Benchmark via `vcpkg` feature `benchmarks`)

## Quick Start (Windows)

**First time — one double-click:**

```bat
START_HERE.bat
```

This checks tools, builds C++, starts PostgreSQL, runs migrations, launches all services, and opens http://localhost:5173.  
If a step fails, it stops with a clear message (`logs\first_run.log`). Fix that issue and run `START_HERE.bat` again.

Already set up:

```bat
scripts\run_dev.bat
```

Dashboard: http://localhost:5173  
Control API: http://localhost:3000

### Daily restart + update + client link

Double-click **`VS_RESTART.exe`** (or `VS_RESTART.bat`):

1. Stops the stack  
2. Pulls latest `main` from GitHub  
3. Starts API, admin desk, client panel, market-core bridge  
4. Opens a Cloudflare tunnel window — send that `https://….trycloudflare.com` URL + access code to the client  

See [docs/VS_RESTART.md](docs/VS_RESTART.md).

## Build

```bat
scripts\build.bat          REM Debug
cmake --preset windows-release
cmake --build build/windows-release
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
scripts\run_paper.bat
scripts\run_replay.bat data\replay\events.mrev
scripts\run_demo.bat
scripts\run_live.bat       REM requires LIVE_TRADING_ENABLED=true
```

## Tests

```bat
scripts\test.bat
scripts\benchmark.bat
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
scripts/        Windows automation
tests/          unit, integration, replay, execution, security, performance
docs/           architecture and operations documentation
```

## Security

- API credentials encrypted at rest (AES-256-GCM)
- Secrets never in frontend, git, or plaintext DB
- Masked credential display in dashboard
- Admin token required for API (production)

## License

Proprietary. All rights reserved.
