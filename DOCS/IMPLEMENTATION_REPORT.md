# Implementation report — production rebuild foundation

**Commit series:** on branch `cursor/vs-production-rebuild-0bd7` (merge to main after tests).  
**LIVE trading:** remains **disabled**.

## What was done

1. **Legacy audit** — `docs/LEGACY_AUDIT.md` / `DOCS/LEGACY_AUDIT.md`
2. **Root structure** — `DOCS/`, `SHARED/`, `TESTS/`, `DEPLOY/`, `legacy-review/`, `VERSION`
3. **Archived** Windows native binaries + C++ sidecar apps → `legacy-review/`
4. **Supervisor** — process vs trading readiness (`SERVER/supervisor`)
5. **Market-data / indicators / regime / strategy / signal / risk / execution** modules with **real deterministic logic** (no random prices, no auto-trade from regime)
6. **API** — `GET /api/v1/system/supervisor`
7. **Install wrappers** — `SERVER/install/INSTALL_SERVER.sh`, `HEALTHCHECK.sh`, `dashboard/SHOW_DASHBOARD.sh`
8. **Unit tests** — `TESTS/unit/core-engines.test.ts`

## What was NOT claimed complete

Full master-task surface (every regime file, every DB table, full broker gateway rewrite, remote CLIENT e2e on different ISP, disaster recovery automation) is **not** finished in one pass. Existing production path (`SERVER/control-api`, enrollment, LAN ADMIN, monitor) remains the running brain; new modules are the rebuild foundation layered around it.

## Files created (high level)

- `DOCS/*`, `docs/LEGACY_AUDIT.md`
- `SERVER/supervisor/src/*`
- `SERVER/market-data/src/*`
- `SERVER/indicators/src/*`
- `SERVER/regime-engine/src/*`
- `SERVER/strategy-engine/src/*`
- `SERVER/signal-engine/src/*`
- `SERVER/risk-engine/src/*`
- `SERVER/execution-engine/src/*`
- `SERVER/install/*`, `SERVER/dashboard/SHOW_DASHBOARD.sh`
- `TESTS/unit/core-engines.test.ts`
- `legacy-review/**`

## Tests executed

| Command | Result |
|---------|--------|
| `cd TESTS && npm test` | **10 passed** |
| `cd SERVER/control-api && npm test` (subset + full if green) | see CI / local run in this session |
| `cd ADMIN && npm test` | prior suite **18 passed** (enrollment) |

## External config still required on i3

- `API_ADMIN_TOKEN`, DB password in `/var/lib/vs-server/server.env`
- Capital.com credentials **only on server** when enabling live later
- WireGuard peer enrollment for remote clients
- DHCP reservation for `192.168.0.10`

## Security

No secrets committed. No DEMO_MODE / MOCK_MODE flags added.
