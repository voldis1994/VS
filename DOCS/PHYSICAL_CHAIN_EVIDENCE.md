# Physical chain evidence — VS CORE

**FINAL PHYSICAL STATUS: NOT ACCEPTED** until the checklist below is filled with
commands run on the real i3 + MSI machines.

## Software root causes addressed (this branch)

1. **`buildMarketStateVector` missing under tsx** — `export *` did not re-export
   named symbols → explicit exports in `SERVER/core/market-intelligence/src/index.ts`
   (and market-data / risk / execution / supervisor indexes).
2. **CI gate** — `moduleContract.test.ts` + `scripts/smoke-production-modules.mts`
   + `deploy/validate-mi-contract.sh` load the same modules production boots.
3. **MSI discovery** — TypeScript `discoverServer` now requires `/health`
   `service=VS-CORE` + `server_id` (rejects random `:3000` HTTP).
4. **Build identity** — `/health` + i3 monitor `[ BUILD / VERSION ]` show
   commit / time / version.
5. **INSTALL_SERVER.sh** — idempotent authoritative path with MI validation,
   systemd stay-up checks, journal module-error scan.
6. **Admin reconnect honesty** — CONNECTION shows
   `CONNECTED → RECONNECTING → DEGRADED → DISCONNECTED` (never fake CONNECTED).

## Operator commands

### i3
```bash
cd ~/VS-new/VS
git pull origin main
sudo bash START_I3
# or: sudo bash SERVER/install/INSTALL_SERVER.sh
curl -sS http://127.0.0.1:3000/health
# must include "service":"VS-CORE" and "build_commit"
ss -ltnp | grep 3000
hostname -I
sudo systemctl is-active vs-server
# stay-up: check again at 5s / 30s / 60s
journalctl -u vs-server -n 30 --no-pager
vs-monitor
```

### MSI
```bat
git pull
REM optional: ADMIN\config\SERVER_IP.txt with i3 LAN IP (one line)
START_MSI.bat
```

Discovery accepts host only if `/health` returns `service=VS-CORE`.

## Evidence table (fill on hardware)

| Item | Result |
|---|---|
| I3 BUILD COMMIT | BLOCKED |
| I3 SYSTEMD STATUS | BLOCKED |
| I3 PROCESS UPTIME | BLOCKED |
| POSTGRES | BLOCKED |
| REDIS | BLOCKED |
| MIGRATIONS | BLOCKED |
| MARKET INTELLIGENCE IMPORT | PASS (software contract + smoke) |
| CONTROL API | BLOCKED |
| PORT 3000 | BLOCKED |
| LOCAL HEALTH | BLOCKED |
| LAN IP | BLOCKED |
| LAN HEALTH | BLOCKED |
| SERVER IDENTITY | BLOCKED |
| LIVE READY | BLOCKED |
| MSI BUILD | BLOCKED |
| DISCOVERED SERVER | BLOCKED |
| TRANSPORT | BLOCKED |
| CONNECTION | BLOCKED |
| HEARTBEAT | BLOCKED |
| ADMIN UI API CONNECTION | BLOCKED |
| I3 SEES MSI | BLOCKED |
| MSI SEES I3 | BLOCKED |
| REBOOT TEST | BLOCKED |
| FAILURE/RECOVERY TEST | BLOCKED |
| TEST SUITES | PASS (control-api 327; ADMIN discovery 21) |
| TYPECHECK | WARN (pre-existing rootDir noise under `tsc --noEmit`) |
| BUILD | PASS (`npm run build` control-api) |
| RUNTIME IMPORT TEST | PASS (`smoke-production-modules.mts`) |

**FINAL PHYSICAL STATUS = NOT ACCEPTED**
