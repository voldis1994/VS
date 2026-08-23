# AURUM — Client Control Panel v2

Standalone client UI (`apps/dashboard/src/client-v2/`). **Does not reuse** legacy `ClientPanelPage` or `ccp-*` styles.

## Stack

- Entry: `src/main.client.tsx` → `ClientApp`
- Build: `npm run build:client` → `dist-client/`
- Public: `tools/client-public.mjs` :18080 or Cloudflare tunnel via `VS.bat`

## Design

- **AURUM** — dark gold cockpit, Syne + IBM Plex Mono
- Central **robot dial** (arm / disarm)
- Horizontal **market chips** (snap-scroll on phone)
- **Position ticket** for live trade
- Bottom **link status bar** (broker + market-core)

## Mobile (phone-first)

Built for clients on the Cloudflare share URL (Safari / Chrome):

- `viewport-fit=cover` + safe-area insets (notch / home indicator)
- Touch targets ≥ 48px; lot ± buttons 56px
- Access code input ≥ 16px (no iOS zoom on focus)
- Sticky header + fixed status bar with safe padding
- Landscape compact grid (dial left, controls right)
- Reduced-motion respected

## Admin preview

http://localhost:5173/client — same v2 app (requires client session / access code)

## API (unchanged)

- `POST /api/client-auth/login`
- `GET /api/client/status`, `/markets`
- `PUT /api/client/config`
- `POST /api/client/start`, `/stop`
- WebSocket `/ws/client`
