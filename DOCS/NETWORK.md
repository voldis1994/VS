# Network

| Zone | Path | Access |
|------|------|--------|
| LAN ADMIN | MSI → Control API `:3000` | Admin auth |
| VPN CLIENT | Client → `10.77.0.1` Client API | Device session |
| Broker | i3 → Capital.com | Server secrets only |

Postgres `:5432` and Redis `:6379` are localhost/docker — not for WG clients or WAN.

See `DOCS/PORTS.md`.
