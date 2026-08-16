# No-Fake Audit

**Policy:** Production paths must not invent HEALTHY/CONNECTED/prices/P/L.

## Search results (production-relevant)

| Match | Location | Classification | Resolution |
|-------|----------|----------------|------------|
| `PLACEHOLDERS` Set | `pipelineBridge.ts` | SAFE | Rejects CHANGE_ME secrets — not fake data |
| Comments “no hardcoded” | hostTelemetry*, acceptanceGate | SAFE | Documentation of honesty |
| `CapitalComEnv = 'demo'\|'live'` | `capitalCom.ts` | CONFIG | Capital API base URL selection; not VS DEMO_MODE |
| `OPERATING_MODE` DEMO string | settings/system | LABEL | Paper/demo **mode label** only; LIVE still fail-closed |
| Synthetic equity seeds | OverviewPage | FIXED earlier | Empty series + NO DATA messaging |
| `/api/system/status` redis/market HEALTHY hardcode | system.ts | FIXED earlier | Redis TCP probe; market UNKNOWN |
| `Math.random` market ticks in SERVER engines | market-data/indicators/regime/strategy/signal/risk/broker-gateway | NONE | Forbidden |
| `DEMO_MODE` / `MOCK_MODE` / `FAKE_MODE` flags | — | NONE | Do not add |
| Broker without credentials | `broker-gateway/capital/health.ts` | FIXED | Returns `CONFIG_REQUIRED`, never CONNECTED |
| Acceptance scripts | FINAL_ACCEPTANCE* | SAFE | FAIL/CONFIG_REQUIRED when unchecked |
| `TODO`/`FIXME` in hot paths | sparse | TRACK | No auth/risk bypass TODOs in enrollment/monitor |

## Rules enforced this pass

1. Broker without credentials → `CONFIG_REQUIRED` (never CONNECTED).
2. Kill switch ACTIVE → deny new risk approvals (`RISK_REJECTED_KILL_SWITCH`).
3. Acceptance scripts never print PASS for unchecked components.
4. Tests may use fixtures under `TESTS/` only.
5. Market feed never fabricates missing bid/ask.

## Residual risk

- Historical C++ under `libs/` / `legacy-review` may contain unrelated patterns — **not imported** by Node production.
- Capital `demo` API host is Capital’s sandbox endpoint name — distinct from inventing market data.
