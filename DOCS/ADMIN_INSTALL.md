# ADMIN install (MSI / Windows 11)

## Canonical product only

```
ADMIN\INSTALL_ADMIN.bat
ADMIN\START_ADMIN.bat
ADMIN\STOP_ADMIN.bat
ADMIN\STATUS_ADMIN.bat
ADMIN\REPAIR_ADMIN.bat
ADMIN\UPDATE_ADMIN.bat
```

Or the `ADMIN\windows\` wrappers (same target).

**UI:** `ADMIN/desktop` (`@vs/admin-desktop`) on **`http://127.0.0.1:5188/`**  
**Never:** `legacy-review/apps/dashboard`, port **5173**, VS SYSTEM / TACTICAL DESK.

Installer uses `Set-StrictMode` and never calls `Get-Content` with a null path (legacy-scan paths are validated before read).

## Requirements

- Node.js 20+
- `API_ADMIN_TOKEN` matching i3 `server.env`
- MSI on same LAN as i3 VS-CORE-01

Discovery: trusted LAN first (default probes include `http://192.168.0.10:3000`). WireGuard is not required for home ADMIN.

ADMIN never contains broker/strategy/execution engines.

## After start

Top bar must show:

- SERVER: VS-CORE-01  
- CONNECTED or DISCONNECTED (live)  
- TRANSPORT: LAN  
- Heartbeat age  

See `DOCS/PHYSICAL_UI_PATH_AUDIT.md` and `DOCS/FINAL_PHYSICAL_ACCEPTANCE.md`.
