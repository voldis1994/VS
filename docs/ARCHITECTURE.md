# Architecture

Market Reader is a layered, event-driven market intelligence engine for short-horizon (~10s) scalping. It is not an indicator bot: decisions flow from multi-source data through structured state, regime, setup, evidence, and EV-based entry/exit.

## System layers

```
MARKET DATA → INGESTION → NORMALIZATION → DATA QUALITY → FEED FUSION
  → FEATURE ENGINE → MARKET STATE → REGIME → SETUP → EVIDENCE
  → ENTRY → EXECUTION ROUTER → BROKER → POSITION MANAGER → EXIT
```

| Layer | Component | Role |
|-------|-----------|------|
| Ingestion | `IMarketDataProvider`, replay/synthetic providers | Emit `MarketEvent` streams |
| Time / normalize | `ClockEngine`, `NormalizationEngine` | Align timestamps, stamp processing windows |
| Quality | `DataQualityEngine` | Stale, gap, crossed, divergent flags |
| Fusion | `FeedFusionEngine` | Consensus mid, spread, divergence, lead/lag |
| Features | `FeatureEngine` | Rolling windows 10ms–60s |
| State | `MarketStateEngine` | Structured snapshot per instrument |
| Regime | `RegimeEngine` | Classify regime + transition history |
| Setup | `SetupEngine` | Discover CONTINUATION / PULLBACK / BREAKOUT candidates |
| Evidence | `EvidenceEngine` | Sequential supporting/contradicting evidence |
| Entry | `EntryEngine` | EV TradeIntents with explainability |
| Execution | `ExecutionRouter` + `IBrokerAdapter` | Multi-account route and fill |
| Position / exit | `PositionManager`, `ExitEngine` | MFE/MAE/peak, EV exit actions |

## Process topology

| Process | Path | Responsibility |
|---------|------|----------------|
| **market-core** | `apps/market-core` | Ingest → pipeline → pending TradeIntents; optional `.mrev` recording |
| **execution-service** | `apps/execution-service` | Route intents, broker orders, position/exit evaluation |
| **control-api** | `apps/control-api` | REST + WebSocket control plane, Postgres, credential encryption |
| **dashboard** | `apps/dashboard` | Operator UI (Vite/React) |

Supporting infra: Postgres + Redis via `docker-compose.yml`. Config YAML under `config/`.

## Data flow

1. Provider callback delivers a `MarketEvent`.
2. Optional `RawEventWriter` records the raw event (magic `MREV`).
3. `NormalizationEngine` produces `NormalizedEvent`.
4. `DataQualityEngine` updates per-source health.
5. `FeedFusionEngine` updates consensus / divergence / lead-lag.
6. Per-instrument `FeatureEngine` snapshots features.
7. `MarketStateEngine` builds a versioned `MarketState`.
8. `RegimeEngine` classifies; `SetupEngine` updates lifecycles.
9. `EvidenceEngine` observes and evaluates; on valid evidence, `EntryEngine` may emit `EntryReady`.
10. `ExecutionRouter` fans out to enabled accounts; adapters fill; `PositionManager` / `ExitEngine` manage open risk.

## Threading model overview

- **market-core**: single primary processing path. Providers invoke a callback that runs `MarketCorePipeline::process_event` synchronously (synthetic/replay). Replay uses a dedicated playback thread inside `ReplayEngine` while the main thread polls `is_running()`.
- **execution-service**: sequential route → order → position evaluate loop (demo/paper bootstrap path).
- **Shared structures**: fixed-capacity `RingBuffer` for feature/feed history (no locks; assume single-writer pipeline). `RawEventWriter` guards disk writes with a mutex. `TelemetryHub` uses atomics for event/decision counters.
- **control-api**: Node.js event loop; WebSocket telemetry broadcast; DB pool for persistence.
- **Dashboard**: browser main thread + WebSocket client for live updates.

Design intent: keep the hot path lock-light and single-threaded per instrument pipeline; isolate I/O (recording, broker HTTP, API) from decision logic where practical.

## Operating modes

`REPLAY` | `PAPER` | `DEMO` | `LIVE` (`mr::OperatingMode`). LIVE requires `LIVE_TRADING_ENABLED=true`.

## Client Control Panel

Public mobile panel at dashboard `/client`. Auth is a separate boundary (`/api/client-auth/*`, `/api/client/*`, `/ws/client`) from admin `x-admin-token`. START/STOP reuses Robot Desk per linked broker account. See `docs/CLIENT_CONTROL_PANEL.md`.
