# Physical chain evidence — VS CORE

**FINAL PHYSICAL STATUS: NOT ACCEPTED** until the checklist below is filled with
commands run on the real i3 + MSI machines.

## Root cause fixed in software (this commit)

`export *` under tsx/Node ESM did **not** re-export named symbols from
`market-intelligence` → physical boot:

`does not provide an export named 'buildMarketStateVector'`

Fix: explicit named exports in `SERVER/core/market-intelligence/src/index.ts`.
Gate: `validate-mi-contract.sh` + vitest `moduleContract.test.ts`.

## Operator commands

### i3
```bash
cd ~/VS-new/VS
git pull origin main
sudo bash START_I3
# or: sudo bash SERVER/install/INSTALL_SERVER.sh
curl -sS http://127.0.0.1:3000/health
# must include "service":"VS-CORE"
ss -ltnp | grep 3000
hostname -I
sudo systemctl is-active vs-server
journalctl -u vs-server -n 30 --no-pager
vs-monitor
```

### MSI
```bat
git pull
REM optional: ADMIN\config\SERVER_IP.txt with i3 LAN IP
START_MSI.bat
```

Discovery accepts host only if `/health` returns `service=VS-CORE`.

## Evidence table (fill on hardware)

| Item | Result |
|---|---|
| I3 BUILD COMMIT | BLOCKED |
| I3 SYSTEMD STATUS | BLOCKED |
| CONTROL API /health | BLOCKED |
| LAN /health | BLOCKED |
| MARKET INTELLIGENCE IMPORT | PASS (software contract test) |
| MSI DISCOVERED SERVER | BLOCKED |
| MSI CONNECTION | BLOCKED |
| I3 SEES MSI HEARTBEAT | BLOCKED |
| REBOOT TEST | BLOCKED |
| FAILURE/RECOVERY TEST | BLOCKED |

**FINAL PHYSICAL STATUS = NOT ACCEPTED**
