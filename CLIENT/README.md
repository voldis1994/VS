# VS CLIENT — Web portal

This is the **only** user-facing web application in VS.

Customer opens a **public HTTPS URL** (Client Gateway `:443`). Nothing is installed on the phone or PC.

## Flow

1. ADMIN (`VS Admin.exe`) → CLIENTS → **CREATE WEB LOGIN**
2. ADMIN copies public URL + login + password (password shown once)
3. Customer opens URL → signs in → market → lot → START/STOP

## Public URL

Whatever is in `/etc/vs/client-url` on i3. Never `:3000`, never localhost.

## Dev

```bash
cd CLIENT/web && npm install && npm run build
```

On i3, `START_I3` builds this into `/opt/vs-server/client-panel` and the gateway serves it on `:443`.
