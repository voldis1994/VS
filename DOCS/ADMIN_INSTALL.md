# ADMIN install (MSI / Windows 11)

```bat
ADMIN\windows\INSTALL_ADMIN.bat
ADMIN\windows\START_ADMIN.bat
ADMIN\windows\STATUS_ADMIN.bat
```

Or from `ADMIN\INSTALL_ADMIN.bat` / `START_ADMIN.bat`.

Requires Node.js 20+ and `API_ADMIN_TOKEN` matching i3 `server.env`.

Discovery: trusted LAN first (default `http://192.168.0.10:3000`). WireGuard not required for home ADMIN.

ADMIN never contains broker/strategy/execution engines.
