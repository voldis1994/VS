# Physical acceptance — VS CORE

**Status: NOT PRODUCTION ACCEPTED**

Automated tests ≠ physical DONE. Mark only with evidence.

## Bugs closed in software (must retest on hardware)

| Bug | Root cause | Fix |
|---|---|---|
| CONTROL API OFFLINE :3000 / monitor | Stale `CONTROL_API_HOST=10.77.0.1` + monitor console blocked by auth | Force `0.0.0.0` under `VS_LAN_MANAGEMENT`; public localhost console routes |
| MSI SERVER OFFLINE | API bound WG-only | Same bind fix + LAN discovery |
| Get-Content Path null | `$file.FullName` when `$file` is string | `LiteralPath` + type check |
| Tactical UI on :5173 | Wrong start path | ADMIN/desktop :5188 only |

## A. i3

```bash
cd ~/VS-new/VS
git pull origin main
sudo bash SERVER/install/INSTALL_I3_SERVER.sh
ss -lntp | grep 3000          # MUST show 0.0.0.0:3000
curl -sS http://127.0.0.1:3000/health
curl -sS http://127.0.0.1:3000/api/v1/server/monitor/console/text | head
vs-monitor                    # auto-refresh; CONTROL API ONLINE
systemctl is-active vs-server
```

Pass only if health OK and monitor shows real host metrics (not OFFLINE).

## B. MSI

```bat
git pull origin main
ADMIN\STOP_ADMIN.bat
ADMIN\INSTALL_ADMIN.bat
ADMIN\START_ADMIN.bat
```

Open `http://127.0.0.1:5188/` — VS ADMIN, VS-CORE-01 CONNECTED, heartbeat changes.
Never open :5173.

## C. CLIENT (WireGuard)

Enroll via ADMIN → WireGuard up → portal `http://10.77.0.1:3000/` → login.
i3 presence shows CLIENT CONNECTED.

## D. End-to-end

- i3 sees MSI ADMIN connected
- i3 sees CLIENT connected
- MSI sees CLIENT
- CLIENT receives its account slice only

## Result table

| Test | Result |
|---|---|
| A i3 install + API + monitor | **BLOCKED** (await hardware) |
| B MSI install + connect | **BLOCKED** |
| C CLIENT WireGuard | **BLOCKED** |
| D E2E presence | **BLOCKED** |

Do not convert BLOCKED → PASS without captured commands/output.
