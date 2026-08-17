# VS — one-shot start

## i3 (Debian server) — FIRST

```bash
cd ~/VS-new/VS
git pull origin main
sudo bash SERVER/START_I3.sh
```

Wait for `SUCCESS`. Note the printed **LAN IP**.

Check:
```bash
curl -sS http://127.0.0.1:3000/health
hostname -I
vs-monitor
```

## MSI (Windows ADMIN) — SECOND

```bat
cd C:\VS-main
git pull
```

If discover used wrong IP, create `ADMIN\config\SERVER_IP.txt` with one line:
```text
192.168.0.53
```
(use the IP from i3 `hostname -I`)

Then:
```bat
ADMIN\START_EVERYTHING.bat
```

Opens **VS ADMIN** at `http://127.0.0.1:5188/`

### Create client web panel

1. ADMIN → **CLIENTS**
2. Enter login name → **CREATE WEB LOGIN**
3. Save the shown **password** (once) and **panel URL**

Client opens:
- Same Wi‑Fi: `http://<i3-LAN-IP>:3000/`
- Remote: WireGuard then `http://10.77.0.1:3000/`

On client portal: **login → choose market → lot size → START / STOP robot**.
