# VS

ONE computer: the MSI. **origin/main is the live prototype.**

## WHAT IS VS?

Market data → **C++ calc** (EntryReady only) → **Node robotDesk** picks BUY/SELL on closed 10s and opens Capital with **0.25% SL**. Best Outcome only moves SL to **BE**. Admin and Client are steering only.

## HOW TO START (MSI)

```bat
cd /d C:\VS
PALAID.bat
```

`PALAID.bat` = `START_MSI.bat`. It **git pull origin main**, rebuilds TACTICAL DESK, restarts Control API. Desk: `http://127.0.0.1:3000/robot`

Needs **Node.js LTS** and **Docker Desktop** (Postgres + Redis on localhost). C++ calc needs **g++** or **MSVC** once (`SERVER\calc\BUILD_CALC.bat`).

Do **not** uninstall Docker Desktop. If an old VS Postgres volume has a different password, `START_MSI.bat` recreates only the VS compose volumes and continues.

Browser opens:

| Door | URL |
|------|-----|
| Control panel (TACTICAL DESK) | http://127.0.0.1:3000/robot |
| Feeds / Orbit | http://127.0.0.1:3000/feeds |
| Client homepage (phone, same Wi-Fi) | PALAID `PHONE` line — `http://<MSI-LAN-IP>:8443/` |

On a phone never type `127.0.0.1` (that is the phone itself). Safari needs the MSI Wi-Fi IP and port **8443**. PALAID writes that into `ADMIN\config\client-url.txt` (it does not overwrite a custom `https://…`).

## WHAT RUNS

1. Postgres + Redis on `127.0.0.1`
2. Control API `:3000`
3. C++ `vs-calc` → `POST /api/pipeline/intents` (EntryReady only — never Capital)
4. robotDesk: closed 10s BUY/SELL → Capital order + 0.25% SL; plus → SL to BE

## FIRST TRADE

1. Brokers — SAVE Capital key + TEST
2. COMMAND or ROBOT BOARD — **PULL CAPITAL**
3. Robot — START Gold
4. Client homepage: PALAID `PHONE` line (`http://<MSI-LAN-IP>:8443/`) — not `127.0.0.1` on the phone

Stop: `powershell -File ADMIN\windows\stop-admin.ps1`

## MAIN PROTOTYPE RULES

- C++ = EntryReady calc, never Capital
- Node robotDesk = BUY/SELL + Capital hands
- Safety SL = 0.25% of price (0.00250)
- Best Outcome = SL to breakeven only (does not close)
- Max 1 open; MARKET CLOSED parks
- Ghost intents released when Capital is flat (no DUPLICATE_INTENT freeze)
- Admin / Client = steering
- No Vite `:5188`, no native `VS Admin.exe` required
