# ADMIN install (MSI Windows)

LAN/Wi-Fi to i3 — WireGuard **not** required for home ADMIN.

```bat
cd C:\VS-main
git pull origin main
cd ADMIN
INSTALL_ADMIN.bat
START_ADMIN.bat
STATUS_ADMIN.bat
STOP_ADMIN.bat
```

Put `ADMIN_TOKEN.txt` next to the bat files:

```
API_ADMIN_TOKEN=<from i3 /var/lib/vs-server/server.env>
```

Expected: `TRANSPORT=LAN`, `INSTALL SUCCESS`, Control Panel at `http://127.0.0.1:5173`.
