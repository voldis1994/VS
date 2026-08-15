# VS AAA / VS CORE — status

## P0 RESULT

**HISTORICAL STRATEGY NOT PROVEN** — see `docs/AAA_P0_STRATEGY_BASELINE.md` and `docs/VS_CORE_PHASE_A_AUDIT.md`.

## P1 RESULT

Declared single production graph: **Node `robotDesk`** — see `docs/AAA_P1_PRODUCTION_GRAPH.md`.

## VS CORE (this branch)

Implemented Phase A–K **foundation in code** (not docs-only):

* `apps/control-api/src/vs-core/**` — Market, Strategy wrap, Risk, Execution, Order SM, Replay, Supervisor, Readiness, Incidents, Updater, Backup, Mobile Auth/API v1
* `robotDesk.enterTrade` — Risk gate + Order SM + **no naked SL** + timeout→reconcile
* `deploy/vs-core/` — Linux boot + systemd + watchdog
* Migration `010_vs_core.sql`
* Tests: **150 PASS** (28 new CORE)

Full matrix: `docs/VS_CORE_RELEASE_REPORT.md`

## LIVE READINESS

**NOT READY** — Capital DEMO E2E and physical appliance remain EXTERNAL BLOCKERS.
