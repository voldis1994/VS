# Client Control Panel — shareable URL

## Option A — Cloudflare (default)

Double-click **`VS.bat`**. It opens a Cloudflare tunnel to **port 18080** (plain Node static+API proxy).

That port is **not Vite**. A health check refuses to open the tunnel if the
response looks like `allowedHosts` / `Blocked request`.

Keep the `VS.bat` window open. Send only the printed `https://….trycloudflare.com`
plus the access code from http://localhost:5173/clients

## Option B — DuckDNS (fixed name, no Cloudflare)

1. Domain e.g. `vs-system.duckdns.org` at https://www.duckdns.org  
2. Put `DUCKDNS_TOKEN` in `.env`  
3. Router forward **18080 → PC:18080** + firewall script  
4. Double-click **`VS-DUCKDNS.bat`**  

Client URL: `http://vs-system.duckdns.org:18080` + access code.

Full steps: [CLIENT_PANEL_DUCKDNS.md](CLIENT_PANEL_DUCKDNS.md)  
Disconnect: **`VS-CLOUDFLARE.bat`**

Admin desk stays local (`http://localhost:5173/`). Do not send that to clients.
