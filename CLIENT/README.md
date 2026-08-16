# VS CLIENT

Device-side application. **Authoritative backend stays on SERVER (i3 VS-CORE-01).**

## [REMOTE CLIENT] enrollment (product path)

Clients may be on any ISP / NAT — **not** the MSI Wi-Fi.

1. **[i3 SERVER]** running (`STATUS_SERVER` READY) with WireGuard up; router forwards UDP **51820** to i3.
2. **[MSI WINDOWS ADMIN]** Control Panel → **NETWORK** → New CLIENT enroll (set `client_id`).
3. **[REMOTE CLIENT]** complete enrollment with the one-time code (device generates X25519 keys locally; private key never leaves the device).
4. Import the generated WireGuard peer config (Endpoint = public IP or DDNS of i3 — never `VS-CORE-01` alone).
5. Client uses private API inside the tunnel (`http://10.77.0.1:3000`) via Connection Manager — no manual ports in product UX.

## Rules

- CLIENT never talks to Capital.com directly
- CLIENT never holds Capital credentials
- START/STOP = server-side trading enabled for client/account scope
- No strategy/risk/server internals UI

## Layout

```
CLIENT/
  BUILD_CLIENT
  app/           # native client app (deferred — not built this phase)
  connection/    # talks to SERVER client-service only
  auth/
  login/
  home/
  market/
  lot-size/
  positions/
  history/
  settings/
```

## Backend on SERVER

`SERVER/control-api` exposes:

- `/api/v1/login`, `/api/v1/refresh`
- `/api/v1/trading/start|stop`
- `/api/v1/status`, positions, lot-size
- Client panel routes under `/api/client-*`
- `/api/v1/network/enrollment/*` for device join

Legacy web panel: `apps/dashboard` (CLIENT LEGACY) — `BUILD_CLIENT` can build it until native app lands.

```bash
# [build machine]
bash CLIENT/BUILD_CLIENT
```
