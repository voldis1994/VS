# VS CLIENT — Web portal

Customer opens a **web URL** on VS CORE (same host as Control API).

## Flow

1. ADMIN → CLIENTS → **CREATE WEB LOGIN** (login name)
2. ADMIN copies URL + login + password (password shown once)
3. Customer opens URL → signs in → selects market → sets lot → START/STOP robot

## Local URL (LAN)

```
http://<i3-LAN-IP>:3000/
```

After server install, `CLIENT/desktop` is built into the static panel served by Control API.

## Dev

```bash
cd CLIENT/desktop && npm install && npm run build
# Point CLIENT_PANEL_DIST or rebuild on i3 so / serves this UI
```

No Git/Node required for the end customer — only a browser + credentials from ADMIN.
