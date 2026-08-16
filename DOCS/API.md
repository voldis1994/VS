# API

## Boundaries

| API | Audience | Auth |
|-----|----------|------|
| Control / Admin | MSI LAN | `x-admin-token` / admin session |
| Client | WireGuard clients | device/client token — **rejects admin token** |

## Version prefix

`/api/v1/...`

## Notable endpoints

- `GET /health`
- `GET /api/v1/system/supervisor` — process vs trading ready
- `GET /api/v1/server/monitor` — i3 + ADMIN shared snapshot
- `POST /api/v1/presence/heartbeat` — ADMIN/CLIENT presence
- `GET /api/v1/presence`
- `GET /api/v1/events/stream` — SSE snapshots
- `GET/POST /api/v1/system/kill-switch`
- `GET /api/v1/broker/health` — CONFIG_REQUIRED when secrets absent
- Client routes under `/api/v1/client/*` and mobile/client panel paths

CLIENT must never receive ADMIN privileges.
