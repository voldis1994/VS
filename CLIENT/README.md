# VS CLIENT

Device-side application. **Authoritative backend stays on SERVER.**

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

Legacy web panel: `apps/dashboard` (CLIENT LEGACY) — `BUILD_CLIENT` can build it until native app lands.
