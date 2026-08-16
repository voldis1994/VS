# CLIENT — Web portal (simple)

Customers do **not** need Git, Node, or a Windows installer for normal use.

## What the customer gets

1. Web address (from ADMIN), e.g. `http://192.168.x.x:3000/`
2. Login + password (created once in VS ADMIN → CLIENTS)

## What they can do after login

- Choose market
- Change lot size
- START / STOP robot

Access works only while ADMIN has enabled the client (credentials issued, not revoked).

## ADMIN steps (MSI)

1. Open VS ADMIN → **CLIENTS**
2. Enter login name → **CREATE WEB LOGIN**
3. Copy **URL / Login / Password** (password shown once)
4. Send to customer securely
5. Link a broker account to that client before markets appear (Capital connection on i3)

## Server requirement

Control API serves `CLIENT/desktop/dist` at `/`.

On i3 after install / update:

```bash
cd /opt/vs-server/../CLIENT/desktop   # or repo CLIENT/desktop
npm ci || npm install
npm run build
sudo bash SERVER/RESTART_SERVER.sh
```

Installer should build this automatically when Node is available.

## Optional WireGuard path

Remote customers over the internet still need a reachable URL (LAN only works on home Wi‑Fi; remote needs public host / reverse proxy / VPN). WireGuard remains available for private-network access, but the product UX is the web portal + login.
