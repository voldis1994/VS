# Operations

## Run modes

| Mode | Script / flag | Behavior |
|------|---------------|----------|
| REPLAY | `scripts\run_replay.bat <file.mrev>` | Deterministic `.mrev` playback; no live risk |
| PAPER | `scripts\run_paper.bat` / `run_dev.bat` | Synthetic feeds + paper broker (default) |
| DEMO | `scripts\run_demo.bat` | Demo broker environment (`OPERATING_MODE=DEMO`) |
| LIVE | `scripts\run_live.bat` | Release binaries; requires `LIVE_TRADING_ENABLED=true` |

Dev stack (core + execution + API + dashboard):

```bat
scripts\run_dev.bat
```

Stop processes and compose services:

```bat
scripts\stop.bat
```

## Monitoring

- **Dashboard Overview / System** — component health and mode  
- **Feeds page** — latency, stale rate, divergence, reliability  
- **`GET /api/system/status`** / **`/api/system/metrics`** — machine-readable health  
- **WebSocket `/ws`** — heartbeats and market updates  
- **`TelemetryHub`** (C++) — events/decisions per second, queue depth, reconnects  
- **Audit Logs** — configuration and credential attachment events  
- **Logging** — `config/logging.yaml` JSON logs under `./logs` with correlation ids (`setup_id`, `trade_intent_id`, `execution_id`, `position_id`, …)

## Health checks

```bat
scripts\doctor.bat
```

Verifies git/cmake/MSVC/node/docker, `VCPKG_ROOT`, `.env`, market-core binary, and `docker compose ps`.

Database: Control API `/health` plus `/api/system/status.database`.

## Troubleshooting

| Symptom | Checks |
|---------|--------|
| Setup script errors | Install missing winget tools; open VS Build Tools C++ shell so `cl` is on PATH |
| vcpkg / CMake fail | Confirm `VCPKG_ROOT`; re-run `scripts\setup_windows.bat` |
| API won’t start | Docker Postgres up; `.env` DB settings; `npm run migrate` in control-api |
| 401 Unauthorized | Set `API_ADMIN_TOKEN` and send `x-admin-token`; or use non-production without placeholder enforcement |
| LIVE refused | Export `LIVE_TRADING_ENABLED=true`; use release build via `run_live.bat` |
| No intents | Feeds healthy? Setup confirmed? Evidence valid? EV/probability thresholds in entry policy |
| Stale exits | Feed latency vs `stale_threshold_ms` (feeds.yaml); EmergencyStop on stale quality |
| Duplicate fills blocked | Expected: router dedupes intent×account after successful execution |
| Dashboard empty | API on :3000, CORS/`VITE_API_URL`, WebSocket URL |

## Rebuild / clean

```bat
scripts\rebuild.bat
scripts\clean.bat
scripts\build.bat
```

Keep `OPERATING_MODE=PAPER` for day-to-day validation. Promote to DEMO only with real broker sandbox credentials encrypted via the Brokers page; enable LIVE only after paper/demo evidence and lot-size review.
