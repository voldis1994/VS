# Ports & network exposure

**Hostname:** VS-CORE-01 (i3 Debian 13)

## Listening / intended exposure

| Port | Protocol | Bind | Who may reach | Notes |
|------|----------|------|---------------|-------|
| 22 | TCP | LAN | ADMIN operators | SSH — restrict as needed |
| 3000 | TCP | LAN + `10.77.0.1` | MSI ADMIN (LAN), CLIENT (VPN) | Control API + Client API process |
| 51820 | UDP | WAN→LAN forward | Remote WireGuard clients | **Must** be public endpoint for remote ISPs |
| 5432 | TCP | localhost / docker bridge only | SERVER only | PostgreSQL — **not** exposed to WG clients or WAN |
| 6379 | TCP | localhost / docker bridge only | SERVER only | Redis — **not** exposed to WG clients or WAN |

## WireGuard conceptual network

- Network: `10.77.0.0/24`
- Server: `10.77.0.1`
- UDP: `51820`

### Required env for remote clients

```
PUBLIC_HOST_OR_IP=<reachable public DNS or WAN IP>
WIREGUARD_PORT=51820
```

Do **not** put `192.168.x.x` into remote client peer endpoints when clients are on other ISPs.

### NAT / router

If VS-CORE-01 is behind a router:

```
WAN UDP 51820  →  VS-CORE-01 LAN IP UDP 51820
```

## Authorization boundaries

- ADMIN Control API routes require admin token / admin session (LAN trusted path).
- CLIENT API uses device/client auth; ADMIN-only routes must return 403 for client tokens.
- PostgreSQL and Redis must remain unreachable from WireGuard client addresses via firewall (`SERVER/network/APPLY_FIREWALL`).

## CONFIG_REQUIRED vs BROKEN

| Condition | Classification |
|-----------|----------------|
| `PUBLIC_HOST_OR_IP` unset for remote deploy | CONFIG_REQUIRED |
| Capital credentials absent | CONFIG_REQUIRED |
| Postgres down / migration fail | BROKEN |
| API process crash | BROKEN |
