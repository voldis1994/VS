# Client Control Panel — shareable URL (REMOTE clients)

## Important

If the client is **not on your Wi‑Fi**, a LAN IP (`192.168.x.x`) will **not** work.

You need a **public HTTPS link** (tunnel or hosted server).

---

## Fast path — Cloudflare tunnel (recommended)

### 1. Start your stack (on your PC)

```bat
REM Control API (port 3000) — however you normally start it
REM then:
cd apps\dashboard
npm run dev:client
```

Client panel listens on `http://127.0.0.1:5174` (local only).

### 2. Open a public tunnel

Double-click or run:

```bat
scripts\share_client_panel.bat
```

It prints a URL like:

```text
https://random-words-xxxx.trycloudflare.com
```

### 3. Send to the client

1. That **https://…trycloudflare.com** link  
2. Their **access code** (from admin `/clients`)

Client can be anywhere with internet. Keep the tunnel window open.

---

## What this is

| Role | URL |
|------|-----|
| You (admin desk) | `http://localhost:5173/` — keep private |
| Client (share) | Cloudflare `https://….trycloudflare.com` → your `:5174` panel |

The client app has **no admin desk**. API + WebSocket go through the same public URL (Vite proxy) — phones never call your `localhost`.

---

## Production (stable domain)

- Host `npm run build:client` (`dist-client`) behind HTTPS on e.g. `https://client.your-domain.com`
- Proxy `/api` and `/ws` to Control API
- Set `VITE_CLIENT_PANEL_URL=https://client.your-domain.com/`
