# Full system audit — 2026-09-21

Audit of Market Reader (VS) across control-api, public client panel, Capital lease, LIVE gates, and admin trading paths.

## Verdict

Prior desk/fanout hardening (lease, SAFETY SL, idempotency, multi-client isolation) remains sound. This pass found and fixed a **critical public-surface gap**: the Cloudflare panel proxy forwarded the entire control-api, while admin/pipeline auth treated `CHANGE_ME` as open in non-production — so tunnel URLs could reach live trading controls.

## Critical findings (fixed)

| ID | Finding | Fix |
|----|---------|-----|
| C1 | `tools/client-public.mjs` proxied all `/api/*` and `/ws/*` | Allowlist: `/health`, `/api/client-auth/*`, `/api/client/*`, `/ws/client` only |
| C2 | Admin auth open when `API_ADMIN_TOKEN=CHANGE_ME` in dev | Fail-closed; `VS.bat` generates secrets; dashboard sends `VITE_ADMIN_TOKEN` |
| C3 | Pipeline open without secret in non-prod | Always fail-closed (escape: `ALLOW_INSECURE_DEV=true`) |
| C4 | `POST /api/system/mode` was public and could force LIVE | Public only for GET; POST requires admin; no auto-enable of `LIVE_TRADING_ENABLED` |
| C5 | `MASTER_ENCRYPTION_KEY` fell back to a known constant | Refuse encrypt/decrypt on placeholder |
| C6 | LIVE defaulted **on** in control-api; C++ did not enforce flag | Default off / PAPER; market-core exits unless `LIVE_TRADING_ENABLED=true` |

## High findings (fixed)

| ID | Finding | Fix |
|----|---------|-----|
| H2 | Capital `withConnectionLock` hold-timeout released mutex while `fn` still ran | Keep mutex until work settles; reject caller only |
| H3 | Admin `POST .../orders` lacked `withEpicEntryLock` / open-epic check | Same TOCTOU guard as robot + fanout |
| H7 | Postgres/Redis bound on all interfaces | `127.0.0.1` only in compose |

## Remaining / follow-ups (not in this PR)

- **H1** Admin `/ws` still unauthenticated on localhost (not proxied publicly after C1).
- **H4** `VS.bat` still self-updates from GitHub `main` (supply-chain risk).
- **H5** Client session token still stored in `localStorage` in addition to HttpOnly cookie.
- **H6** Access-code login scans all clients (DoS/timing) — rate limit exists; indexed lookup still TODO.
- **M2–M6** In-memory flip lock / process-local epic locks / fanout 10s auto-key — document single-writer assumption.

## What remains healthy

- Capital lease + `requireAccountId` on robot/fanout/admin orders  
- SAFETY SL fail-closed (no naked entries) on main paths  
- Fanout ownership checks + idempotency claims  
- Client session scoping + `assertNoSecrets` on client payloads  
- Regime books keyed `a{account}::{epic}` for multi-client same-epic  

## Proof

```bash
cd apps/control-api && npm test
```

Key suites: `fullSystemAudit.proof.test.ts`, `clientIsolation.test.ts`, `encryption.test.ts`, `clientPipelineChain.test.ts`.

Public panel: `node tools/check-public.mjs` (after `VS.bat`) must exit 0 and reject admin proxy paths.
