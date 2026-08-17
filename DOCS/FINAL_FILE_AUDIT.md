# Final file audit

## PRODUCTION FILES

| Path | Role |
|---|---|
| `START_I3` | Canonical i3 start |
| `START_MSI.bat` | Canonical MSI start |
| `SERVER/MAKE_IT_WORK.sh` | Install/update engine invoked by START_I3 |
| `SERVER/install/INSTALL_SERVER.sh` | Full install / repair |
| `SERVER/control-api/` | VS CORE HTTP API :3000 |
| `SERVER/client-gateway/` | Public CLIENT door :443 |
| `SERVER/core/` | Market intelligence / engines |
| `SERVER/network/APPLY_FIREWALL` | Port policy |
| `SERVER/MONITOR_SERVER` | Operator TUI (`vs-monitor`) |
| `SERVER/database/docker-compose.yml` | Postgres + Redis localhost bind |
| `ADMIN/desktop/` | ADMIN UI source |
| `ADMIN/runtime/serve-admin.mjs` | Production static UI on :5188 |
| `ADMIN/windows/start-admin.ps1` | MSI start implementation |
| `ADMIN/INSTALL_ADMIN.bat` `STOP_ADMIN.bat` `RESTART_ADMIN.bat` | Operator helpers |
| `CLIENT/desktop/` | CLIENT web UI (built into Control API + gateway) |
| `TESTS/` | Automated tests |
| `DOCS/` | Current docs |
| `old version/` | Archive only |

## OLD VERSION FILES

See `old version/README.md`. Includes `legacy-review`, `DEPLOY`, duplicate start scripts, stub `client-api`, superseded reports.

| OLD PATH | NEW PATH | REASON | PRODUCTION REFERENCES REMOVED |
|---|---|---|---|
| `legacy-review/` | `old version/architecture/legacy-review/` | Pre-production tactical stack | YES |
| `DEPLOY/` | `old version/deploy/DEPLOY/` | Duplicate copies | YES |
| `START_I3.sh` | `old version/scripts/START_I3.sh` | Duplicate of START_I3 | YES |
| `FORCE_I3_LAN` | `old version/scripts/FORCE_I3_LAN` | Absorbed into START_I3 | YES |
| `ADMIN/CONNECT_FORCE.bat` | `old version/admin/CONNECT_FORCE.bat` | Absorbed into START_MSI | YES |
| `ADMIN/START_CONTROL_PANEL` | `old version/admin/START_CONTROL_PANEL` | Vite :5173 | YES |
| `SERVER/client-api/` | `old version/server/client-api/` | Unwired stub; gateway is :443 | YES |
| `docker-compose.yml` | `SERVER/database/docker-compose.yml` | Canonical DB compose | YES |

## DELETED FILES

None of the archive was deleted. Generated `dist/` and `node_modules/` remain gitignored (not moved).

## GENERATED / GITIGNORED

`node_modules/`, `dist/`, `*.log`, `ADMIN/config/control-panel.env`, `runtime-config.js`, `*.pem`, `*.key`, PID files.
