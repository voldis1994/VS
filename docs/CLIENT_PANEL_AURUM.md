# AURUM — Client Control Panel v2

Standalone client UI (`apps/dashboard/src/client-v2/`). **Does not reuse** legacy `ClientPanelPage` or `ccp-*` styles.

## Stack

- Entry: `src/main.client.tsx` → `ClientApp`
- Build: `npm run build:client` → `dist-client/`
- Public: `tools/client-public.mjs` :18080 or Cloudflare tunnel via `VS.bat`

## Design

- **AURUM** — dark gold cockpit, Syne + IBM Plex Mono
- Central **robot dial** (arm / disarm)
- Horizontal **market chips**
- **Position ticket** for live trade
- Bottom **link status bar** (broker + market-core)

## Admin preview

http://localhost:5173/client — same v2 app (requires client session / access code)

## API (unchanged)

- `POST /api/client-auth/login`
- `GET /api/client/status`, `/markets`
- `PUT /api/client/config`
- `POST /api/client/start`, `/stop`
- WebSocket `/ws/client`
