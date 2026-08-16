# Final Acceptance Report

**Generated:** 2026-08-16  
**Git commit SHA:** `bf1054f3b088621d3476338e7d7e0663e1c5a0de`  
**Environment:** Cursor cloud agent — **no physical i3 / MSI / remote CLIENT**

## 1. Commit

`bf1054f3b088621d3476338e7d7e0663e1c5a0de`

## 2. Repository cleanup summary

- Renamed `Old-system/` → `legacy-review/`
- Renamed UIs: `SERVER/monitor`, `ADMIN/desktop`, `CLIENT/desktop` (removed `-v2` parallel naming)
- Deleted compatibility engine shims (`SERVER/*-engine`, `market-data`, `indicators`, `supervisor`, `broker-gateway`)
- Deleted empty CLIENT stub folders and empty SERVER placeholder dirs
- Removed `boot.sh` legacy fallbacks
- Fixed `DEPLOY/` symlinks
- README describes only final three-product architecture

## 3. Deleted / archived

| Action | Items |
|--------|-------|
| ARCHIVED | Entire former `Old-system/` tree → `legacy-review/` |
| DELETED | Engine shim trees; CLIENT README stubs; `SERVER/dashboard` shim |
| MIGRATED | UI paths, installers, packaging scripts, presence CLIENT heartbeat mirror |

## 4. Final tree

See `DOCS/FINAL_REPOSITORY_MAP.md`.

## 5. Server services (repo)

| Service | Status |
|---------|--------|
| Control API | PASS (code + 306 tests) |
| Client API package | PASS boundary |
| Supervisor PROCESS≠TRADING | PASS |
| Monitor (`SERVER/monitor` + MONITOR_SERVER) | PASS code / physical BLOCKED |
| systemd `vs-core.service`, `vs-server-monitor.service`, `vs-monitor.service` | PASS present |
| WireGuard scripts | PASS present |
| EXPORT_CLIENT.sh | PASS present |

## 6. Database migrations

`SERVER/database/migrations/` 001–013 — PASS (repository). Hardware apply: **BLOCKED**.

## 7. API

ADMIN + CLIENT routes under `/api/v1/*` — documented in `DOCS/API.md`. Security tests PASS.

## 8–10. Install results

| Target | Result |
|--------|--------|
| i3 INSTALL_SERVER | **BLOCKED** (no Debian host) |
| systemd after reboot | **BLOCKED** |
| MSI INSTALL_ADMIN | **BLOCKED** (no Windows host) |
| CLIENT package | Folder package PASS; `VS_CLIENT_SETUP.exe` **BLOCKED** (needs Windows packager) |

## 11. Automated tests

| Suite | Result |
|-------|--------|
| SERVER/control-api | **306 PASS** |
| TESTS | **32 PASS** |
| ADMIN | **18 PASS** |
| SERVER/client-api | **3 PASS** |
| ADMIN/desktop build | **PASS** |
| CLIENT/desktop build | **PASS** |

## 12–13. Physical tests

| Test | Result |
|------|--------|
| MSI ↔ i3 LAN | **BLOCKED** |
| Remote CLIENT different ISP | **BLOCKED** |

## 14–16. Market / Broker / Trading

| Item | Status |
|------|--------|
| Market | **NOT_CONFIGURED / UNAVAILABLE** without provider |
| Broker | **CONFIG_REQUIRED** without Capital secrets |
| PROCESS_READY | code path PASS; physical **BLOCKED** |
| TRADING_READY | **NO** (fail-closed) |

## 17. Screenshots

`DOCS/screenshots/*.png` — offline honesty states. Live hardware shots: **BLOCKED**.

## 18. Remaining blockers

1. Physical i3 Debian install + reboot + monitor TTY  
2. Physical MSI LAN ADMIN + presence  
3. Remote CLIENT + `PUBLIC_HOST_OR_IP` + UDP 51820 (CGNAT may block)  
4. Capital credentials  
5. Live market provider  
6. Windows `VS_CLIENT_SETUP.exe` CI packager  
7. Operator LIVE enablement after gates  

## Requirement marks

| Requirement | Mark |
|-------------|------|
| ONE server / ADMIN / CLIENT architecture | PASS |
| No production legacy imports | PASS (0) |
| Compatibility shims removed | PASS |
| Automated tests | PASS |
| No production fake prices/clients | PASS |
| i3 / MSI / remote physical | BLOCKED |
| TRADING READY | NO |
