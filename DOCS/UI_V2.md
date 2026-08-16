# UI v2 — Visual rebuild

**Authoritative visual target:** supplied VS reference image (black / graphite / VS green).

## New generation (production)

| Product | Path | Launch |
|---------|------|--------|
| i3 Server Panel | `SERVER/dashboard-v2/` | `bash SERVER/SHOW_DASHBOARD_V2.sh` or `SERVER/dashboard-v2/INSTALL_PANEL_AUTOSTART.sh` |
| MSI ADMIN | `ADMIN/apps/dashboard-v2/` | `ADMIN\INSTALL_ADMIN.bat` → `START_ADMIN.bat` (prefers v2) |
| CLIENT | `CLIENT/apps/client-v2/` | `scripts/BUILD_CLIENT_PACKAGE.sh` + `CLIENT\windows\INSTALL_CLIENT.bat` |

Old UI archived under `legacy-review/ui/dashboard` — **not imported** by v2 (test: `TESTS/unit/no-legacy-ui-imports.test.ts`).

## Presence

- `POST /api/v1/presence/heartbeat`
- `GET /api/v1/presence`
- ADMIN dashboard heartbeats every poll → i3 shows CONNECTED / DISCONNECTED from live heartbeat age (10s ONLINE / 30s OFFLINE defaults).

## Honesty rules

No fake prices, clients, P/L, or CONNECTED. Empty states show **NO DATA** / **DISCONNECTED** / **0 CLIENTS**.

## Screenshots

Store under `DOCS/screenshots/`. Physical capture on i3/MSI/CLIENT required for acceptance — see `DOCS/screenshots/README.md`.
