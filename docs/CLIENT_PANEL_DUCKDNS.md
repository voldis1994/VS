# Client panel via DuckDNS (no Cloudflare)

Stable share URL for remote clients while VS runs on your PC (or a home server laptop).

## What you already have

- DuckDNS domain: `vs-system.duckdns.org`
- Public panel process: `tools/client-public.mjs` on **`:18080`** (binds `0.0.0.0`)
- Client UI: market / lot / START-STOP / live trade only (no admin desk)

## One-time setup

### 1) `.env` (repo root)

```env
PUBLIC_SHARE_MODE=duckdns
DUCKDNS_DOMAIN=vs-system.duckdns.org
DUCKDNS_TOKEN=paste_token_from_duckdns_org
CLIENT_CORS_ORIGIN=http://localhost:5173,http://localhost:5174,http://127.0.0.1:18080,http://vs-system.duckdns.org:18080
CLIENT_COOKIE_SECURE=false
VITE_CLIENT_PANEL_URL=http://vs-system.duckdns.org:18080
```

Token: DuckDNS account page → **token** (not the domain name).

### 2) Windows Firewall (once, Admin PowerShell)

```bat
powershell -ExecutionPolicy Bypass -File tools\open-firewall-18080.ps1
```

### 3) Router port forward

```
External TCP 18080  →  this PC local IP : 18080
```

Find local IP: `ipconfig` → IPv4 (e.g. `192.168.1.50`). Prefer a DHCP reservation so it does not change.

### 4) Start

Double-click **`VS.bat`** (or `VS-DUCKDNS.bat`).

When `PUBLIC_SHARE_MODE=duckdns`:

- starts DuckDNS IP updater window
- does **not** start Cloudflare
- prints: `http://vs-system.duckdns.org:18080`

Send that URL + access code from Admin → Clients.

## Test

1. Keep `VS.bat` window open  
2. Phone on **mobile data** (not Wi‑Fi): open `http://vs-system.duckdns.org:18080`  
3. Login with access code → START  

If it fails: usually router forward, ISP CGNAT, or firewall — not DuckDNS itself.

## Disconnect / go back to Cloudflare

In `.env`:

```env
PUBLIC_SHARE_MODE=cloudflare
```

Or delete / comment DuckDNS lines. Next `VS.bat` uses the Cloudflare tunnel again.

Also remove the router port forward when you no longer want the panel on the public internet.

## Security notes

- This is **HTTP** (not HTTPS) for the first test — fine for a short trial on a private access code  
- Do **not** share admin `:5173`  
- Revoke access codes you no longer need (Clients → REVOKE)  
- Later: Caddy + HTTPS on 443 if you keep DuckDNS long-term
