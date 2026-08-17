# VS

ONE CORE on i3 Debian. TWO doors: private ADMIN and public CLIENT.

## WHAT IS VS?

A trading core (market data → intelligence → strategy → execution) that runs only on the i3 server. MSI is the administrator console. Customers use a web login.

## WHAT RUNS ON i3?

VS-CORE-01: Control API `:3000` (LAN), Client Gateway `:443` (public HTTPS), PostgreSQL `:5432`, Redis `:6379`, market feeds, supervisor, native **VS Server Monitor**.

## WHAT RUNS ON MSI?

Native **VS Admin.exe** (Python 3 + PySide6). It talks to i3 `:3000` over LAN. No browser. No local UI port. No trading logic.

## WHAT DOES CLIENT OPEN?

The stable public URL in `/etc/vs/client-url` (HTTPS `:443`). Never `:3000` and never localhost. This is the only web UI in VS.

## HOW TO INSTALL i3?

```bash
cd ~/VS-new/VS
git pull origin main
sudo bash SERVER/install/INSTALL_SERVER.sh
```

## HOW TO START i3?

```bash
sudo bash START_I3
```

Then set the public client URL **once**:

```bash
echo 'https://your.stable.host' | sudo tee /etc/vs/client-url
# optional TLS:
# /etc/vs/tls/fullchain.pem
# /etc/vs/tls/privkey.pem
sudo systemctl restart vs-client-gateway
```

## HOW TO INSTALL MSI?

```bat
cd /d C:\VS-main
git pull origin main
echo I3_LAN_IP> ADMIN\config\SERVER_IP.txt
ADMIN\windows\BUILD_ADMIN.bat
```

## HOW TO START MSI?

```bat
START_MSI.bat
```

That launches **one** `VS Admin.exe` window. If it is already running, the existing window is focused.

Stop: `powershell -File ADMIN\windows\stop-admin.ps1`

## WHAT URL DOES CLIENT USE?

Whatever you wrote in `/etc/vs/client-url`. Git pull / rebuild / restart does not change that file.

## WHERE ARE OLD FILES?

`old version/` — archive only. Production does not use it. Archived ADMIN web UI lives in `old version/admin/web/`.

## HOW TO CHECK HEALTH?

```bash
curl -fsS http://127.0.0.1:3000/health
# must include "service":"VS-CORE" and "server_id":"VS-CORE-01"
vs-monitor
```

See `DOCS/ARCHITECTURE.md`.
