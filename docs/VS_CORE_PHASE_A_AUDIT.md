# VS CORE — PHASE A AUDIT + FREEZE

**Freeze commit:** `c123101478126b23df4d87751680dd53f8c204ec` (`main` tip at branch start)  
**Branch:** `cursor/vs-core-os-master-0bd7`  
**Generated:** 2026-08-15T10:20:00Z  

## Strategy baseline

| Field | Value |
| --- | --- |
| STATUS | **HISTORICAL_STRATEGY_NOT_PROVEN** |
| Reason | No host `.vs-build-sha`, launcher log, or decision DB dump in this environment |
| Last git-correlated candidate | `e0e479a` (2026-08-13 ~17:43 UTC, SL 0.20% of price) |
| Working baseline used | Current `main` strategy modules (proven by source + unit tests, not by host runtime SHA) |
| STRATEGY_VERSION pin | see `apps/control-api/src/vs-core/versions.ts` |

Operator proof still required on Windows host — see `docs/AAA_P0_STRATEGY_BASELINE.md`.

## Production execution chain (proven by source)

```
VS.bat / VS.exe (Windows launcher — REMOVE from production target)
  → Docker PG/Redis
  → control-api robotDesk (~2s cycle)
       → capitalCom session/quote
       → robotReader + publicInternetFeeds (advisory)
       → tenSecondOhlc → regimes → entryFromRegime
       → staleQuoteGuard / with-trend gates
       → createCapitalPosition (INLINE risk)
       → exitManage
```

**Single LIVE brain today:** Node `robotDesk` (not C++ market-core / execution-service).

## Component classification

| Component | Class | Rationale |
| --- | --- | --- |
| `entryFromRegime.ts` | **MIGRATE** | Real with-trend strategy — preserve algorithm |
| `tenSecondOhlc.ts` | **KEEP** | Pure, tested 10s bars |
| `regimes.ts` | **MIGRATE** | Real classifier; isolate per client/epic book |
| `staleQuoteGuard.ts` | **KEEP** → Risk adapter | Proven lag veto |
| `exitManage.ts` | **MIGRATE** | Real manage/exit heuristics |
| `capitalCom.ts` | **MIGRATE** | Real Capital REST adapter → Session Manager |
| `decisionCodes.ts` | **KEEP** / wire fully | Catalog real; SM transitions incomplete |
| `encryption.ts`, `clientSession.ts`, `accessCode.ts` | **KEEP** | Solid control-plane security |
| `clientAuth` / `clientPanel` routes | **MIGRATE** → `/api/v1` | Real auth; version for mobile |
| DB migrations 001–009 | **KEEP** + extend | Base schema real |
| `robotDesk.ts` enter/manage loop | **REWRITE** (staged) | Working monolith → Risk + Order SM + reconcile |
| `robotReader.ts` cross-tenant fusion | **REWRITE** | Do not fuse all clients’ Capital legs |
| `intentFanout.ts` | **MIGRATE** / gate | Secondary brain; desk wins when entry_enabled |
| `publicInternetFeeds.ts` | **MIGRATE** (advisory) | Reference only — never execution truth |
| C++ libs (feature/setup/evidence/…) | **ARCHIVE** / optional | Real prototypes; not LIVE path |
| C++ `market-core` bridge | **REMOVE** from prod graph | Optional fan-in only |
| C++ `execution-service` | **REMOVE** from prod graph | Paper one-shot demo |
| `VS.bat`, `GET-VS.bat`, `FIX.ps1`, `VS.exe` | **REMOVE** from Linux appliance | Windows chaos |
| Vite dashboard as trading dependency | **REMOVE** from prod boot | Admin UI optional later |
| Cloudflare tunnel | **REMOVE** from trading path | Share URL only — never order dependency |
| Fake READY / UNKNOWN decisions | **REMOVE** | Use WAIT_*/ERROR_* only |

## Phase plan (implementation order)

| Phase | Focus | Gate |
| --- | --- | --- |
| A | Freeze + audit + baseline pin | This document |
| B | Linux runtime + supervisor + readiness | Boot READY/NOT READY tests |
| C | Market Core + raw store + replay shell | Tick quality / REPLAY isolation |
| D | Strategy Core wrap (no algo rewrite) | Strategy unit + version on decisions |
| E | Risk + Execution + Order SM | Order safety tests |
| F | Capital DEMO path (credentials EXTERNAL) | Adapter + reconcile tests; DEMO E2E blocked without creds |
| G | DB events + reconciliation | Migration + reconcile tests |
| H | Supervisor recovery + incidents | Crash-loop / incident tests |
| I–J | Control API v1 + mobile auth | Isolation + auth tests |
| K | Updater + backup | Rollback / restore unit tests |
| L | Acceptance report | `VS_CORE_RELEASE_REPORT.md` |

## EXTERNAL BLOCKERS

* Physical VS CORE appliance (i3 host) install / NTP / SMART
* Capital.com DEMO/LIVE credentials
* Operator `.vs-build-sha` for historical strategy proof
* Operator approval for any LIVE money validation
