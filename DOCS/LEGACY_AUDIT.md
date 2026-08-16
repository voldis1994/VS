# VS Legacy Audit

**Date:** 2026-08-16  
**Repo tip at audit:** `main` @ `6ac750b` (and successors)  
**Auditor:** Cursor production-rebuild agent  

## Executive summary

The repository contains **two overlapping architectures**:

1. **Active production path (KEEP):** Node.js `SERVER/control-api` + `ADMIN` + `CLIENT` + `apps/dashboard`, Docker Postgres/Redis, WireGuard under `SERVER/network`, systemd via `INSTALL_I3_SERVER` / `vs-server.service`, local monitor `/api/v1/server/monitor`.
2. **Parallel / historical C++ stack (DO NOT IMPORT FROM NODE RUNTIME):** top-level `libs/*`, `apps/market-core`, `apps/execution-service`, CMake/`VS.exe` artifacts. Not what i3 `vs-server` boots today.

This rebuild **extends and reorganizes** the Node production path. It does **not** delete working enrollment, monitor, LAN ADMIN, or broker adapter code. Useful obsolete trees are staged under `legacy-review/` (or documented as freeze candidates) and must not be imported by production.

---

## A. What is authoritative today (KEEP / EXTEND)

| Area | Location | Notes |
|------|----------|--------|
| Control API + trading core | `SERVER/control-api` | Fastify; `src/vs-core/*` engines |
| Boot / appliance | `SERVER/control-api/src/vs-core/runAppliance.ts` | systemd `ExecStart` via `deploy/boot.sh` |
| Admin agent + monitor contract | `adminAgent.ts`, `serverMonitor.ts` | Shared MSI + i3 console |
| Private network / enrollment | `vs-core/network/*` | Device registry, WG peers, ADMIN enroll |
| Postgres | Docker `market-reader-postgres`, `src/db/*` | Migrations present |
| Redis | Docker `market-reader-redis` | Optional; probed honestly |
| WireGuard ops | `SERVER/network/*` | SETUP / UP / firewall |
| i3 install | `SERVER/INSTALL_I3_SERVER`, `INSTALL_MONITOR` | Idempotent appliance install |
| MSI ADMIN | `ADMIN/*.bat`, `ADMIN/windows/*.ps1`, `apps/dashboard` | LAN-first discovery |
| Client package | `CLIENT/*` | App shells + BUILD_CLIENT |
| Live trading | `LIVE_TRADING_ENABLED=false` default | Fail-closed; keep |

---

## B. Obsolete / duplicate / risky

| Item | Finding | Action |
|------|---------|--------|
| `libs/*` C++ engines | Parallel regime/market/execution stack; not wired to `vs-server` | Freeze; document; optional move to `legacy-review/cpp-libs` |
| `apps/market-core`, `apps/execution-service` | C++/sidecar apps unused by Node boot | Stage under `legacy-review/apps-*` |
| Root `VS.exe`, `VS_RESTART.exe`, `VS.bat` | Windows binary packaging; not ADMIN Control Panel | Stage under `legacy-review/windows-native` |
| `docs/` vs `DOCS/` | Mixed casing; incomplete vs master task | Consolidate into `DOCS/` going forward |
| `/api/system/status` historical hardcodes | Previously invented HEALTHY for redis/market | Partially fixed on main; remaining honesty via `/api/v1/server/monitor` |
| Overview equity charts | Synthetic seeds removed on main | Keep empty until real broker series exists |
| `OPERATING_MODE=DEMO` string | Env name only — **not** a DEMO_MODE product flag | Do not invent DEMO_MODE; treat as PAPER/REPLAY labels |
| Multiple installers | `INSTALL_SERVER`, `INSTALL_I3_SERVER`, `1_START_I3` | Canonical: `INSTALL_I3_SERVER` (+ new `install/INSTALL_SERVER.sh` wrapper) |
| Symlink `apps/control-api` → `SERVER/control-api` | Good | Keep |

---

## C. Demo / mock / fake-data scan

| Pattern | Result |
|---------|--------|
| `DEMO_MODE` / `MOCK_MODE` / `FAKE_MODE` product flags | **Not present** as enablement switches (do not add) |
| `Math.random()` market prices in production path | Not used for live quotes in control-api vs-core |
| Fake clients in monitor | Device registry only — real enrollments |
| Capital credentials in git | Must remain out of git (`.env` / `server.env` local) |

Known honesty gaps still to harden in this rebuild:

- Trading readiness must stay **separate** from process readiness (`TRADING_READY=false` until gates pass).
- Regime/strategy modules must consume **validated** market objects, never invent ticks.
- Empty equity charts preferred over synthetic curves.

---

## D. Secrets / machine state (DO NOT DELETE)

On the physical i3 host (not necessarily in git):

- `/var/lib/vs-server/server.env` — tokens, DB password
- `/var/lib/vs-server/network/keys` — WG private keys
- Docker volumes for Postgres

Never commit these. Never print them in dashboards.

---

## E. Rebuild policy

1. **Canonical brain:** `VS-CORE-01` = Node `SERVER/control-api` under supervisor.
2. **New module folders** under `SERVER/` wrap or gradually extract `vs-core` — production imports only from `SERVER/` and `SHARED/`.
3. **`legacy-review/`** is dead to runtime (enforced by package boundaries + audit note).
4. **ADMIN / CLIENT** remain thin clients of Control API / Client API.
5. **LIVE trading stays disabled** until explicit operator gates (already policy).

---

## F. Staged moves in this rebuild

See git history for actual `git mv` operations. Candidates:

- `legacy-review/cpp-libs` ← documentation pointer / selective freeze of unused C++ apps
- `legacy-review/windows-native` ← root `VS.exe` family if moved

Active `SERVER/control-api`, `ADMIN`, `CLIENT`, `apps/dashboard` stay in place.
