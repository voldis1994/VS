# Client Control Panel — shareable URL

## What to send to a client

**Client-only app (recommended):**

```text
http://YOUR-LAN-IP:5174/
```

or production:

```text
https://client.your-domain.com/
```

This is a **separate** web app from the admin desk (`:5173`). No admin menu, no trading desk — only login + market + lot + START/STOP.

## How to start (local)

```bash
# Terminal A — Control API
cd apps/control-api && npm run dev

# Terminal B — Admin desk (you)
cd apps/dashboard && npm run dev
# → http://localhost:5173/

# Terminal C — Client panel (send this to clients)
cd apps/dashboard && npm run dev:client
# → http://localhost:5174/
# → http://<your-pc-lan-ip>:5174/   (phone / other device on same Wi‑Fi)
```

## Access for the client

1. Admin creates client + generates **access code** (`/clients` on admin desk).
2. Send client: **panel URL** + **access code**.
3. Client opens URL → LOGIN → choose market/lot → START.

## Production

- Host `npm run build:client` output (`apps/dashboard/dist-client`) on a dedicated host/subdomain.
- Set `VITE_CLIENT_PANEL_URL` and include that origin in `CLIENT_CORS_ORIGIN`.
