# Final acceptance report

## FINAL STATUS

**NOT PRODUCTION ACCEPTED**

Reason: physical i3/MSI/CLIENT hardware retest still required after Control API bind + monitor auth + installer fixes.

## 1. FINAL ARCHITECTURE

```
VS/
├── SERVER/          # i3 authoritative (control-api :3000, core, db, monitor, install)
├── ADMIN/desktop    # MSI Control Panel :5188
├── CLIENT/          # remote web portal via WireGuard
├── SHARED/
├── TESTS/
├── DOCS/
└── legacy-review/   # non-production only
```

Chain:

```
MARKET → i3 VS-CORE-01 → Control API
              ├─ LAN → MSI ADMIN
              └─ WireGuard → CLIENT
```

## 2. REMOVED / NEUTRALIZED LEGACY

- Production START refuses tactical desk / :5173
- Old UI under `legacy-review/` only
- Stale WG-only API bind overridden by LAN management bind policy

## 3. SERVER

- `vs-server.service` → `deploy/boot.sh` → control-api (`0.0.0.0:3000` when VS_LAN_MANAGEMENT=1)
- docker `market-reader-postgres`, `market-reader-redis` (adopt-on-conflict)
- `vs-monitor` / SHOW_LIVE_MONITOR (localhost console API)

## 4. DATABASE

Migrations through `014_market_intelligence.sql` (ticks, candles_10s, market_states, setups, …)

## 5. MARKET PIPELINE

```
FEED → tick validate → normalize → 10s OHLC
  → intelligence vector → strategy setup PASS/FAIL
  → SL/BE/TP/exit → OSM → reconcile
```

## 6. ADMIN

`ADMIN\INSTALL_ADMIN.bat` / `REPAIR_ADMIN.bat` / `UPDATE_ADMIN.bat` → `START_ADMIN.bat` → `ADMIN/desktop` :5188 → i3 LAN API

## 7. CLIENT

ADMIN provisions login → WireGuard → `http://10.77.0.1:3000/`

## 8. TESTS

| Suite | Status |
|---|---|
| privateNetwork / bind | PASS (software) |
| auth public monitor | PASS (software) |
| canonical /api/v1 | PASS (software) |
| serverMonitor | PASS (software) |
| Physical A–D | **BLOCKED** |

## 9. PHYSICAL ACCEPTANCE

See `DOCS/PHYSICAL_ACCEPTANCE.md`.

## 10. KNOWN REMAINING ISSUES

- Hardware retest pending
- LIVE trading fail-closed without broker secrets/evidence
- Strategy module set incomplete vs full master list
- Dual route prefixes (`/api/*` and `/api/v1/*`) — v1 aliases added; full cleanup later

## 11. FINAL STATUS

**NOT PRODUCTION ACCEPTED**
