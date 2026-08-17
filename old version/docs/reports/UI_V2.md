# UI (final production paths)

| Surface | Path | Launch |
|---------|------|--------|
| i3 Server Panel | `SERVER/monitor/` | `bash SERVER/SHOW_DASHBOARD.sh` or `SERVER/monitor/INSTALL_PANEL_AUTOSTART.sh` |
| MSI ADMIN | `ADMIN/desktop/` | `ADMIN\INSTALL_ADMIN.bat` → `START_ADMIN.bat` |
| CLIENT | `CLIENT/desktop/` | `scripts/BUILD_CLIENT_PACKAGE.sh` + `CLIENT\START_CLIENT.bat` |

Archived UI: `legacy-review/apps/dashboard` — **not imported** (test: `TESTS/unit/no-legacy-ui-imports.test.ts`).

Design: black/graphite + VS green. Runtime values from Control/Client API only — never fake LIVE/CONNECTED.
