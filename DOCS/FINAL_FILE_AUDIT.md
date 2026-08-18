# File audit

| Path | Role |
|------|------|
| `START_I3` | Canonical i3 operator start |
| `START_MSI.bat` | Canonical MSI operator start → VS Admin.exe |
| `PALAID.bat` | Old operator name from archive; aliases `START_MSI.bat` |
| `ADMIN/desktop/` | Native PySide6 VS Admin source |
| `ADMIN/windows/BUILD_ADMIN.bat` | Canonical Windows PyInstaller build |
| `ADMIN/windows/start-admin.ps1` | Called by START_MSI.bat |
| `ADMIN/windows/stop-admin.ps1` | Stop VS Admin.exe |
| `ADMIN/windows/dist/VS Admin.exe` | Production artifact (built on MSI, not committed) |
| `SERVER/monitor/main.py` | Native PySide6 VS Server Monitor |
| `SERVER/MONITOR_SERVER` | GUI first, TUI fallback |
| `CLIENT/web/` | Public CLIENT HTTPS web UI |
| `SERVER/client-gateway/` | Public :443 door |
| `old version/admin/web/` | Archived React/Vite ADMIN |
| `old version/admin/web-runtime/` | Archived localhost :5188 runtime |
| `old version/server/monitor-web/` | Archived HTML server panel |

Production must not launch Vite ADMIN, `serve-admin.mjs`, or a browser wrapper.

Extra Windows BAT helpers and CLIENT desktop launchers live in `old version/`. Canonical operator files are `PALAID.bat` (alias of `START_MSI.bat`) and `ADMIN/windows/BUILD_ADMIN.bat`.
