# VS_RESTART.exe — one-click full system restart

## What it does

Double-click **`VS_RESTART.exe`** (repo root on Windows):

1. Stops running VS services (market-core, API, dashboards, tunnel)
2. `git pull` latest **`main`** from GitHub
3. Starts Docker DB, migrations, Control API, admin desk, **client panel**
4. Starts **market-core LIVE `--bridge`** (Client Panel → Capital path)
5. Opens Cloudflare tunnel window for a **public client URL**

## Requirements

- VS repo already cloned (run `START_HERE.bat` once before first use)
- Git, Node, Docker Desktop running
- Internet (for git pull + tunnel)

## After it finishes

| Who | What |
|-----|------|
| You | Admin `http://localhost:5173/clients` — create client + access code |
| Client (remote) | Copy `https://….trycloudflare.com` from **MR-ClientTunnel** window + access code |

Client: open link → login → market + lot → START.

## Files

| File | Role |
|------|------|
| `VS_RESTART.exe` | Double-click launcher |
| `VS_RESTART.bat` | Same flow without .exe |
| `scripts/vs_restart_full.bat` | Actual restart logic |
| `scripts/stop_all_vs.bat` | Stop helper |

## Rebuild the .exe (developers)

```bash
cd tools/vs-restart
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o ../../VS_RESTART.exe .
```
