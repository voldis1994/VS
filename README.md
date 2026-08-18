# VS

ONE computer: the MSI. No i3 server.

## WHAT IS VS?

Market data → **C++ calc** (vein/flow/EV/best outcome) → **Node robotDesk** opens/closes Capital. Admin and Client are steering only.

## HOW TO START (MSI)

```bat
cd /d C:\VS
git pull origin main
START_MSI.bat
```

`PALAID.bat` is the same command.

Needs **Node.js LTS** and **Docker Desktop** (Postgres + Redis on localhost). C++ calc needs **g++** or **MSVC** once (`SERVER\calc\BUILD_CALC.bat`).

Do **not** uninstall Docker Desktop. If an old VS Postgres volume has a different password, `START_MSI.bat` recreates only the VS compose volumes and continues.

Browser opens:

| Door | URL |
|------|-----|
| Control panel (TACTICAL DESK) | http://127.0.0.1:3000/robot |
| Feeds / Orbit | http://127.0.0.1:3000/feeds |
| Client web | http://127.0.0.1:3000/ |

## WHAT RUNS

1. Postgres + Redis on `127.0.0.1`
2. Control API `:3000`
3. C++ `vs-calc` → `POST /api/pipeline/intents` (EntryReady only — never Capital)
4. robotDesk Capital hands execute queued calc

## FIRST TRADE

1. Brokers — SAVE Capital key + TEST
2. Accounts — PULL CAPITAL → SAVE EPIC
3. Robot — START
4. Client URL for customers: http://127.0.0.1:3000/ (or this MSI LAN IP once you set `VS_LAN_MANAGEMENT=1`)

Stop: `powershell -File ADMIN\windows\stop-admin.ps1`

## RULES

- C++ = calc
- Node = Capital hands only
- Admin / Client = steering
- No Vite `:5188`, no native `VS Admin.exe` required
