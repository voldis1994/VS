# VS CORE RELEASE REPORT

**Generated:** 2026-08-15  
**Branch:** `cursor/vs-core-os-master-0bd7`  
**Freeze (Phase A):** `c123101478126b23df4d87751680dd53f8c204ec`

## VERSIONS

| Field | Value |
| --- | --- |
| CORE VERSION | `0.1.0-vs-core` |
| GIT COMMIT | (this branch tip — see git) |
| STRATEGY VERSION | `node-robot-desk-main-c123101` |
| CONFIG VERSION | `1` |
| DB VERSION | `010` (migration `010_vs_core.sql`) |
| STRATEGY BASELINE | **HISTORICAL_STRATEGY_NOT_PROVEN** (candidate `e0e479a`) |

## ACCEPTANCE MATRIX

| Gate | Result | Evidence |
| --- | --- | --- |
| HARDWARE | **EXTERNAL BLOCKER** | No physical i3 appliance in cloud agent |
| BOOT | **PASS** (logic) | `boot.ts` + `readiness.ts` + unit tests; systemd units under `deploy/vs-core/` |
| NETWORK | **PASS** (probe API) | Readiness requires NETWORK probe — no fake OK without probe |
| TIME | **PASS** (logic) | `timeSync.ts` + drift test; host NTP still EXTERNAL |
| STORAGE | **PASS** (logic) | `storageHealth.ts` free-space thresholds |
| DATABASE | **PASS** (schema) | Migration 010; runtime PG still env-dependent |
| MARKET CORE | **PASS** | `marketCore.ts` + stale/offline gates tested |
| STRATEGY CORE | **PASS** | Wraps real `entryFromRegime` — no algo rewrite; version on decisions |
| RISK CORE | **PASS** | Independent `evaluateRisk`; wired into `robotDesk.enterTrade` |
| EXECUTION CORE | **PASS** | Order SM + timeout→reconcile (no blind retry) tested |
| CAPITAL DEMO | **EXTERNAL BLOCKER** | No DEMO credentials in this environment |
| ORDER LIFECYCLE | **PASS** (unit) | Deterministic SM + execution tests |
| RECONCILIATION | **PASS** (unit) | `positionReconcile.ts` mismatch detection |
| CRASH RECOVERY | **PARTIAL** | Supervisor restart/crash-loop; full broker rebuild needs DEMO |
| SUPERVISOR | **PASS** | `supervisor.ts` dependency order + crash-loop |
| INCIDENT CENTER | **PASS** | `incidentCenter.ts` |
| CONTROL API | **PASS** | Existing control-api + `/api/v1/*` mobile |
| CLIENT ISOLATION | **PASS** (unit) | Mobile auth assertClientAccess + existing isolation tests |
| MOBILE API | **PASS** | `/api/v1` login/status/start/stop/lot/incidents; broker order → 403 |
| SECURITY | **PARTIAL** | Auth/rate-limit/encryption kept; host firewall EXTERNAL |
| UPDATE | **PASS** (unit) | SHA-256 verify + health FAIL → ROLLBACK |
| ROLLBACK | **PASS** | Updater unit test |
| BACKUP | **PASS** | Encrypted secrets + restore round-trip |
| RESTORE | **PASS** | Backup restore test |
| REPLAY | **PASS** | Replay engine; Risk blocks broker in REPLAY |
| REGRESSION | **PASS** | Existing strategy unit tests still green (150 total) |

## CRITICAL ISSUES

**0** open CRITICAL defects in implemented CORE path.

## HIGH ISSUES

1. Capital DEMO E2E not run (credentials EXTERNAL BLOCKER).
2. Historical strategy SHA still unproven (operator host proof required).
3. `robotDesk` still owns the live loop — Risk/Execution integrated on entry, but full extraction of manage/exit into separate long-running services is incomplete.
4. Appliance host hardening (firewall, non-root user creation, NTP daemon) requires physical/server install.

## KNOWN LIMITATIONS

* Windows `VS.bat` / Vite dashboard / Cloudflare tunnel remain in repo for migration continuity; they are **classified REMOVE from production graph** and are not part of Linux `deploy/vs-core` boot.
* C++ `market-core` / `execution-service` remain ARCHIVE/optional — not LIVE brain.
* LIVE money path blocked by default on appliance (`LIVE_TRADING_ENABLED=false`).
* Mobile UI app not built — API contracts + auth ready for VS CONTROL.

## AUTOMATED TEST GATE (this revision)

```
cd apps/control-api && npm test
→ 20 files, 150 tests PASS (28 new VS CORE)
```

## LIVE READINESS

**NOT READY**

Requires: operator-confirmed strategy baseline SHA (optional for DEMO), Capital DEMO credentials, appliance install with NTP, Capital DEMO E2E acceptance, then operator-controlled LIVE validation approval.

## SOURCE CHANGED (this phase)

* `apps/control-api/src/vs-core/**` — CORE modules
* `apps/control-api/src/services/robotDesk.ts` — Risk + Order SM + no naked SL
* `apps/control-api/src/index.ts` + `middleware/auth.ts` — `/api/v1`
* `apps/control-api/src/db/migrations/010_vs_core.sql`
* `deploy/vs-core/**` — Linux boot + systemd + watchdog
* `docs/VS_CORE_PHASE_A_AUDIT.md`, `docs/VS_CORE_RELEASE_REPORT.md`

## EXTERNAL BLOCKERS (continue elsewhere)

* Physical VS CORE server access
* Capital.com DEMO/LIVE API credentials
* Operator `.vs-build-sha` paste for historical strategy proof
* Operator approval for LIVE money validation
