# File audit

| Path | Role |
|------|------|
| `START_I3` | Canonical i3 operator start |
| `START_MSI.bat` | Canonical MSI operator start → VS Admin.exe |
| `ADMIN/desktop/` | Native PySide6 VS Admin source |
| `ADMIN/windows/BUILD_ADMIN.bat` | Canonical Windows PyInstaller build |
| `ADMIN/windows/dist/VS Admin.exe` | Production artifact (built on MSI, not committed) |
| `SERVER/monitor/main.py` | Native PySide6 VS Server Monitor |
| `SERVER/MONITOR_SERVER` | GUI first, TUI fallback |
| `CLIENT/web/` | Public CLIENT HTTPS web UI |
| `SERVER/client-gateway/` | Public :443 door |
| `old version/admin/web/` | Archived React/Vite ADMIN |
| `old version/admin/web-runtime/` | Archived localhost :5188 runtime |
| `old version/server/monitor-web/` | Archived HTML server panel |

Production must not launch Vite ADMIN, `serve-admin.mjs`, or a browser wrapper.
