# Physical UI path audit — why MSI still showed TACTICAL DESK

**Status:** Software path corrected on this branch.  
**Physical MSI retest:** `PHYSICAL_ACCEPTANCE_PENDING`

## 1. Exact old UI source discovered

| String / chrome | Exact production source (archive only) |
|---|---|
| `VS SYSTEM` | `legacy-review/apps/dashboard/src/components/Logo.tsx` |
| `TACTICAL DESK` | `legacy-review/apps/dashboard/src/components/Logo.tsx` |
| `COMMAND` (nav) | `legacy-review/apps/dashboard/src/components/Layout.tsx` |
| `ROBOT BOARD` / robot desk | `legacy-review/apps/dashboard/src/pages/RobotDeskPage.tsx`, Layout nav |
| Neon tactical CSS | `legacy-review/apps/dashboard/src/styles/global.css` |
| Dev port **5173** | `legacy-review/apps/dashboard/vite.config.ts` (`server.port: 5173`) |
| HTML title `VS SYSTEM` | `legacy-review/apps/dashboard/index.html` |

Repository-wide search (production trees `ADMIN/`, `CLIENT/`, `SERVER/`, `DEPLOY/`):

- **Zero** matches for `TACTICAL DESK`, `ROBOT BRAIN`, `DRIFT GUARD` outside `legacy-review/`.
- User-visible labels like “ROBOT BRAIN” / “DRIFT GUARD” / “READINESS” were part of the old tactical chrome/experience; the only remaining UI tree that can render that desk is `legacy-review/apps/dashboard`.

## 2. Why MSI was still launching it

Root causes (combined):

1. **Stale Vite process on `127.0.0.1:5173`**  
   Old tactical dashboard used port **5173**. If a previous checkout (or `apps/dashboard` / `Old-system` path) left Vite running, the browser kept showing the old desk even after repo consolidation.

2. **Wrong mental model of “admin started”**  
   Opening whatever was already on `:5173` is not the same as running the canonical `START_ADMIN.bat` for `ADMIN/desktop`.

3. **Historical dual path**  
   Before consolidation, Windows start helpers could land on the old dashboard. After consolidation the source moved under `legacy-review/`, but a still-running process / old working copy on the MSI laptop continued to serve the old UI.

4. **Not a README problem**  
   Canonical scripts already preferred `ADMIN/desktop`; the physical failure was a **startup/port/product-path** failure, not missing docs.

## 3. Files removed / neutralized from production startup

| Change | Purpose |
|---|---|
| `ADMIN/windows/start-admin.ps1` | **Only** starts `ADMIN/desktop` on **5188** with `--strictPort`; hard-checks `@vs/admin-desktop` + `<title>VS ADMIN</title>`; kills **5173** and **5188**; refuses `legacy-review` CWD |
| `ADMIN/windows/stop-admin.ps1` | Kills **5188** and stale **5173** |
| `ADMIN/START_ADMIN.bat` | Validates desktop package/title before calling `start-admin.ps1` |
| `ADMIN/1_START_WINDOWS.bat` / `.ps1` | Redirect **only** to canonical START (no `tsx app/startAdmin.ts` as product UI) |
| `ADMIN/windows/install-admin.ps1` | Installs + builds `ADMIN/desktop` only; scans for legacy markers; never installs `apps/dashboard` |
| `DEPLOY/windows/admin` | Symlink → `ADMIN/windows` (not a second product) |

Old UI source remains under **`legacy-review/apps/dashboard`** for historical review only. No production BAT/PS1 imports or starts it.

## 4. Canonical ADMIN path

```
ADMIN/
  desktop/          ← ONLY Control Panel UI (@vs/admin-desktop, port 5188)
  windows/
    INSTALL_ADMIN.bat
    START_ADMIN.bat
    STOP_ADMIN.bat
    STATUS_ADMIN.bat
    install-admin.ps1
    start-admin.ps1
    stop-admin.ps1
  START_ADMIN.bat   ← preferred double-click entry
  INSTALL_ADMIN.bat
```

## 5. Exact START_ADMIN.bat execution chain

```
ADMIN\START_ADMIN.bat
  → verify ADMIN\desktop\package.json contains @vs/admin-desktop
  → verify ADMIN\desktop\index.html title = VS ADMIN
  → powershell ADMIN\windows\start-admin.ps1
       → resolve repo ADMIN/desktop
       → refuse legacy markers / legacy-review CWD
       → load ADMIN\config\control-panel.env
       → probe VS-CORE-01 LAN (/health)
       → write ADMIN\desktop\public\runtime-config.js (apiBase, token, LAN)
       → kill listeners on 5173 and 5188
       → npm exec vite --host 127.0.0.1 --port 5188 --strictPort
       → open http://127.0.0.1:5188/
```

**Product URL after fix:** `http://127.0.0.1:5188/`  
**Old tactical URL:** `http://127.0.0.1:5173/` — killed on start; not used by production scripts.

## 6. Canonical SERVER monitor / CLIENT

| Product | Path | Launch |
|---|---|---|
| i3 SERVER monitor | `SERVER/monitor`, `SERVER/SHOW_LIVE_MONITOR.sh` | `sudo bash SERVER/SHOW_LIVE_MONITOR.sh` |
| MSI ADMIN | `ADMIN/desktop` | `ADMIN\START_ADMIN.bat` → `:5188` |
| CLIENT | `CLIENT/desktop` (+ web portal via Control API) | WireGuard → `http://10.77.0.1:3000/` |

## 7. API endpoints used by ADMIN desktop

- `POST /api/v1/presence/heartbeat` — ADMIN presence to i3  
- `GET /api/v1/server/monitor` — health, CPU/RAM/disk, clients, uptime  
- `GET /api/v1/presence` — ADMIN/CLIENT presence list  
- `GET /api/v1/system/supervisor` — process/trading readiness (real probes)  
- `GET /api/v1/broker/health` — broker state  
- `GET /api/v1/market` — market status/quotes when available  
- `GET /api/v1/position` — positions / P/L when available  
- `GET /api/v1/incidents` — incidents when available  

Missing data renders **UNKNOWN / UNAVAILABLE / NO DATA / DISCONNECTED** — never `Math.random()` or demo rows.

## 8. Heartbeat mechanism

ADMIN polls ~1.5s (backoff on failure): heartbeat POST then monitor GET.  
UI shows `CONNECTED`/`DISCONNECTED`, `TRANSPORT: LAN`, and `Heartbeat: Ns ago`.  
When i3 is unreachable, CONNECTED flips to DISCONNECTED without a manual browser refresh.

## 9. Regression test

`TESTS/unit/admin-no-legacy-ui.test.ts` fails if production ADMIN contains:

- `TACTICAL DESK`
- `ROBOT BRAIN`
- `DRIFT GUARD`

and asserts START resolves to `ADMIN/desktop` on port **5188**.
