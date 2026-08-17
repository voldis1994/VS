# Final physical acceptance — MSI ADMIN UI replacement

**Software implementation:** COMPLETE on branch (canonical ADMIN path + regression tests).  
**Physical hardware acceptance:** `PHYSICAL_ACCEPTANCE_PENDING`

Do **not** treat automated tests alone as 100% DONE for field deployment.

## Definition checklist (software)

| Requirement | Status |
|---|---|
| Old tactical UI removed from production startup | PASS — only under `legacy-review/` |
| One canonical ADMIN frontend | PASS — `ADMIN/desktop` |
| One canonical CLIENT product | PASS — `CLIENT/desktop` (+ server-served portal) |
| One canonical SERVER monitor | PASS — `SERVER/monitor` + `SHOW_LIVE_MONITOR.sh` |
| Windows launcher starts correct ADMIN | PASS — `START_ADMIN.bat` → desktop `:5188` |
| ADMIN uses real i3 API data | PASS — monitor/presence/market/broker/… |
| No fake dashboard numbers | PASS — NO DATA / UNKNOWN / DISCONNECTED |
| Legacy UI regression test | PASS — `TESTS/unit/admin-no-legacy-ui.test.ts` |
| Production ADMIN build | Run `npm run build` in `ADMIN/desktop` |

## Physical tests (must run on real hardware)

### TEST A — i3

1. Boot i3 Debian VS-CORE-01.  
2. `sudo bash SERVER/SHOW_LIVE_MONITOR.sh`  
3. Expect continuously updating **VS CORE SERVER** monitor (CPU/RAM/services/clients/ADMIN).

**Result:** PENDING (hardware)

### TEST B — MSI

1. `git pull` latest on MSI.  
2. `ADMIN\STOP_ADMIN.bat` (kills `:5188` and stale `:5173`).  
3. `ADMIN\INSTALL_ADMIN.bat`  
4. `ADMIN\START_ADMIN.bat`  
5. Browser must open **`http://127.0.0.1:5188/`** showing **VS ADMIN** (not VS SYSTEM / TACTICAL DESK).  
6. Top bar: `VS-CORE-01`, `CONNECTED`, `TRANSPORT: LAN`, heartbeat age.  
7. i3 monitor must show **ADMIN CONNECTED**.

**Result:** PENDING (hardware)

### TEST C — disconnect

1. Disconnect MSI Wi‑Fi.  
2. MSI UI → **DISCONNECTED** without manual refresh.  
3. i3 → ADMIN disconnected after heartbeat timeout.  
4. Reconnect → both **CONNECTED**.

**Result:** PENDING (hardware)

### TEST D — remote CLIENT

1. Client on different Internet via WireGuard.  
2. Client connects to VS-CORE-01 portal.  
3. i3 monitor and MSI ADMIN show the same client.  
4. Disconnect client → both update.

**Result:** PENDING (hardware)

## MSI operator notes (critical)

- If you still see **TACTICAL DESK**, you are on **`:5173`** or an old checkout.  
- Run `STOP_ADMIN.bat`, then `START_ADMIN.bat`, use only **`http://127.0.0.1:5188/`**.  
- Do not bookmark `:5173`.  
- Do not run anything under `legacy-review/`.

## API / heartbeat (summary)

See `DOCS/PHYSICAL_UI_PATH_AUDIT.md` for the full BAT→Vite→React chain and endpoint list.

## Remaining blockers for “LIVE trading ready”

Unrelated to this UI path fix: Capital broker credentials, market feed readiness, and risk gates may still keep **TRADING READY = NO**. That does not authorize fake LIVE values on the ADMIN panel.
