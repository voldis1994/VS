# Physical acceptance — VS CORE

**Status: NOT PRODUCTION ACCEPTED / BLOCKED on physical hardware**

Automated tests ≠ physical DONE. Mark only with evidence from i3 Debian + MSI Windows.

## Software closed in this revision (must retest on hardware)

| Item | Expected on hardware |
|------|----------------------|
| ADMIN | `START_MSI.bat` → native `VS Admin.exe` window, no browser |
| ADMIN ports | `netstat` must NOT show listener on 5173 or 5188 after start |
| ADMIN identity | header `VS-CORE-01` `CONNECTED` `LAN` with live `/health` |
| Server monitor | `vs-monitor` native GUI when DISPLAY exists; TUI if headless |
| CLIENT | browser → stable HTTPS `:443` only web UI |

## A. i3

```bash
cd ~/VS-new/VS
git pull origin main
sudo bash START_I3
ss -lntp | grep -E '3000|443'
curl -sS http://127.0.0.1:3000/health
vs-monitor
```

Pass only if health is VS-CORE-01 and monitor shows real host metrics.

## B. MSI

```bat
git pull origin main
echo I3_LAN_IP> ADMIN\config\SERVER_IP.txt
ADMIN\windows\BUILD_ADMIN.bat
START_MSI.bat
```

Native **VS Admin** window. VS-CORE-01 CONNECTED. No Chrome/Edge. No `localhost:5188`.

```bat
netstat -ano | findstr "5173 5188"
```

Must be empty for ADMIN-owned listeners.

## C. CLIENT

Enroll via ADMIN → Clients → CREATE WEB LOGIN.  
Open the **public HTTPS URL** from `/etc/vs/client-url`. Never `:3000`.

## D. End-to-end

- i3 monitor shows MSI ADMIN connected
- Client START reaches CORE
- Reboot i3: Admin shows RECONNECTING then CONNECTED without restarting the exe
