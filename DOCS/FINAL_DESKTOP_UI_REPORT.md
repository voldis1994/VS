# VS desktop UI correction — final report

CORE / network from PR #70 is unchanged: one VS CORE on i3, Control API `:3000` (LAN), CLIENT gateway `:443`.

This revision replaces the remaining generic Qt shells with a native operator UI family. ADMIN is not a browser page. SERVER MONITOR is not an HTML page. CLIENT remains the only web UI.

**Status: NOT PRODUCTION ACCEPTED.** Automated tests pass on this Linux agent. Physical MSI / i3 display / external HTTPS client checks are **BLOCKED**.

## 1. Changed files (this revision)

Native ADMIN (`ADMIN/desktop/`):

- `ui/theme.py`, `ui/main_window.py`, `ui/format.py`
- `widgets/chrome.py`, `widgets/metric_bar.py`
- dedicated pages: Dashboard, Server, Clients, Accounts, Market, Trading, Strategies, Execution, Positions, Orders, Trades, Incidents, Logs, Backups, Updates, Settings
- `services/live.py` empty-state defaults (no invented market status)
- tests: `test_pages.py` plus existing launch / reconnect / no-listen / identity tests

Native SERVER MONITOR (`SERVER/monitor/`):

- `monitor_app/window.py`, `theme.py`, `chrome.py`, `tui.py`
- `main.py` — GUI when `DISPLAY`/`WAYLAND_DISPLAY`; quality TUI otherwise
- `SHOW_PANEL.sh`, `README.md`, `tests/test_tui.py`, `tests/test_monitor_ui.py`

CLIENT web (still HTTPS, still the only browser UI):

- `CLIENT/web/src/pages/ClientPortal.tsx` — LOGIN / HOME / POSITIONS / HISTORY / SETTINGS
- `CLIENT/web/src/styles/client.css` — quote board + mobile-first layout
- `SERVER/control-api/src/services/clientPanel.ts` — live `quote` from existing robot ticks (no trading logic added)

Production port cleanup:

- `SERVER/INSTALL_I3_SERVER` — CORS no longer points at `:5188`
- `.env.example` — removed ADMIN Vite `:5173` listen comments
- `DOCS/PORTS.md`

## 2. Archived files

Unchanged from PR #70 archive layout:

- `old version/admin/web/` — React/Vite ADMIN
- `old version/admin/web-runtime/` — `serve-admin.mjs` / localhost `:5188`
- `old version/server/monitor-web/` — HTML i3 panel
- `old version/admin/helpers/` — extra BAT helpers
- `old version/client/` — CLIENT desktop launchers

## 3. Deleted generated / obsolete production files

- `ADMIN/desktop/pages/resource.py` — generic dump page
- `ADMIN/desktop/pages/settings.py` — merged into dedicated Settings page

No `ADMIN/native-new/`, `ADMIN/final/`, `ADMIN/v2/`, `BUILD_ADMIN_NEW.bat`.

## 4. Final directory tree (production UI)

```
ADMIN/
  desktop/          native PySide6 (main.py)
  windows/          BUILD_ADMIN.bat, start-admin.ps1, stop-admin.ps1
  config/
  tests/connection/ LAN identity tests (not a UI server)
CLIENT/
  web/              HTTPS client (Vite build → :443)
SERVER/
  monitor/          native Linux GUI + TUI
  control-api/      :3000
  client-gateway/   :443
START_I3
START_MSI.bat
```

## 5. Final port table

| Port | Role |
|------|------|
| **3000** | Private Control / ADMIN API (i3, LAN / WireGuard) |
| **443** | Public CLIENT HTTPS |
| **5432** | PostgreSQL internal |
| **6379** | Redis internal |
| **51820/udp** | WireGuard |
| **5188** | removed from production |
| **5173** | removed from production |

ADMIN desktop does not listen on any TCP port.

## 6. ADMIN technology

Python 3 + PySide6 / Qt 6. Canonical artifact: `VS Admin.exe` via `ADMIN/windows/BUILD_ADMIN.bat` (PyInstaller `vs_admin.spec`). Talks to i3 `:3000` over HTTP + WebSocket. No trading business logic.

## 7. SERVER monitor technology

Python 3 + PySide6 native Linux GUI. Headless / `VS_MONITOR_TUI=1` → structured TUI (`monitor_app/tui.py`). Closing the monitor does not stop VS CORE.

## 8. CLIENT technology

HTTPS web app (`CLIENT/web`). Browser only. Mobile-first LOGIN / HOME / POSITIONS / HISTORY / SETTINGS. Served from `:443`. Nothing to install.

## 9. VS Admin.exe build result

**BLOCKED on this agent.** This environment is Linux. `BUILD_ADMIN.bat` / PyInstaller Windows exe was not run. Source, spec, and start scripts are in place. Physical MSI must run:

```bat
ADMIN\windows\BUILD_ADMIN.bat
START_MSI.bat
```

## 10. Automated test results (this agent)

| Suite | Result |
|-------|--------|
| ADMIN desktop pytest | **15 PASS** |
| SERVER monitor pytest | **3 PASS** |
| TESTS vitest | **67 PASS** |
| ADMIN connection vitest | **22 PASS** |
| architecture tests (`production-architecture`, `admin-no-legacy-ui`) | **13 PASS** |

Offscreen Qt grabs (not physical acceptance): `DOCS/screenshots/admin-dashboard.png`, `admin-clients.png`, `admin-trading.png`, `admin-market.png`, `admin-positions.png`, `server-monitor.png`.

## 11. Physical tests required — BLOCKED

This cloud agent has no MSI Windows box and no i3 graphical session.

Still required on hardware:

1. `ADMIN\windows\BUILD_ADMIN.bat` produces `VS Admin.exe` that runs without a system Python
2. `START_MSI.bat` opens one native window; second run focuses the existing window
3. `netstat` has **no** listener on `5173` or `5188`
4. Header: `VS-CORE-01` · `CONNECTED` · `LAN` with live i3 data
5. Disconnect i3 → `RECONNECTING` / `DISCONNECTED` without closing Admin; restore → `CONNECTED` without Admin restart
6. i3 `START_I3` → native **VS Server Monitor** on the physical screen (TUI only if headless)
7. External device: HTTPS `:443` login → CLIENT HOME → START

## 12. Screenshots

| Shot | File | Status |
|------|------|--------|
| VS Server Monitor | `DOCS/screenshots/server-monitor.png` | offscreen chrome only — **BLOCKED** live i3 |
| VS Admin Dashboard | `DOCS/screenshots/admin-dashboard.png` | offscreen chrome only — **BLOCKED** live MSI |
| VS Admin Clients | `DOCS/screenshots/admin-clients.png` | offscreen |
| VS Admin Trading | `DOCS/screenshots/admin-trading.png` | offscreen |
| CLIENT Login | — | **BLOCKED** no public `:443` |
| CLIENT Home | — | **BLOCKED** |
| CLIENT Running | — | **BLOCKED** |
| CLIENT Positions | — | **BLOCKED** |
| CLIENT mobile | — | **BLOCKED** |

Do not treat unit tests or offscreen grabs as DONE.
