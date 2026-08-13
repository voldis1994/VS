# Operations

## Run modes

Palaišana: **`VS.bat`** (git pull + LIVE stack + klienta tunelis).

## Monitoring

- **Dashboard Overview / System** — component health and mode  
- **Feeds page** — latency, stale rate, divergence, reliability  
- **`GET /api/system/status`** / **`/api/system/metrics`** — machine-readable health  
- **WebSocket `/ws`** — heartbeats and market updates  
- **`TelemetryHub`** (C++) — events/decisions per second, queue depth, reconnects  
- **Audit Logs** — configuration and credential attachment events  
- **Logging** — `config/logging.yaml` JSON logs under `./logs` with correlation ids (`setup_id`, `trade_intent_id`, `execution_id`, `position_id`, …)

## Health checks

Control API `/health` plus `/api/system/status.database`. Docker: `docker compose ps`.

## Troubleshooting

| Symptom | Checks |
|---------|--------|
| Setup script errors | Install missing winget tools; open VS Build Tools C++ shell so `cl` is on PATH |
| vcpkg / CMake fail | Confirm `VCPKG_ROOT`; bootstrap `third_party\vcpkg` then `cmake --preset windows-msvc-release` |
| API won’t start | Docker Postgres up; `.env` DB settings; `npm run migrate` in control-api |
| 401 Unauthorized | Set `API_ADMIN_TOKEN` and send `x-admin-token`; or use non-production without placeholder enforcement |
| LIVE refused | Export `LIVE_TRADING_ENABLED=true`; use Release `market-core.exe` |
| No intents | Feeds healthy? Setup confirmed? Evidence valid? EV/probability thresholds in entry policy |
| Stale exits | Feed latency vs `stale_threshold_ms` (feeds.yaml); EmergencyStop on stale quality |
| Duplicate fills blocked | Expected: router dedupes intent×account after successful execution |
| Dashboard empty | API on :3000, CORS/`VITE_API_URL`, WebSocket URL |

Keep `OPERATING_MODE=PAPER` for day-to-day validation. Promote to DEMO only with real broker sandbox credentials encrypted via the Brokers page; enable LIVE only after paper/demo evidence and lot-size review.
