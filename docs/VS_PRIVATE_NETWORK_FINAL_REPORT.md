# VS PRIVATE NETWORK — PRODUCT READY FOR PHYSICAL INSTALLATION

PR: https://github.com/voldis1994/VS/pull/52  
HEAD: `8392f8ee42b6ca9da395985cdd90c7e78c953fed`
**LIVE_READY: false** — PHYSICAL_i3 / CAPITAL_REAL_DEMO / HISTORICAL_BASELINE remain EXTERNAL_BLOCKER (never mocked)

## Product architecture (not Phase 1)

- **WireGuard** = encrypted transport; **SERVER** = hub + Network Authority
- **ADMIN → SERVER**, **CLIENT → SERVER**; CLIENT ↛ ADMIN; CLIENT ↛ CLIENT; CLIENT ↛ Capital
- End users know **SERVER_ID** (`VS-CORE-01`) — Connection Manager resolves internal endpoints (ports are internal)
- Addressing: SERVER `10.77.0.0/24` (`.1`), ADMIN `10.77.1.0/24`, CLIENT `10.77.10.0/20`
- Durable registry + Postgres schema `011_vs_private_network.sql` (private keys never in DB/git)
- Enrollment: single-use, short-lived, revocable; preferred path = key on device
- Fail-closed: `VS_PRIVATE_NETWORK=1` + WG down → management NOT READY (no public HTTP / `0.0.0.0` fallback)
- Permissions: OWNER_ADMIN / CLIENT; default DENY; client isolation from authenticated identity
- Command idempotency (`command_id`); reconnect does not replay START/STOP/lot/market

## Results

| Gate | Result |
|------|--------|
| SERVER INSTALLER | **PASS** (foundation; idempotent) |
| ADMIN INSTALLER | **PASS** (foundation + local key + SERVER_ID config) |
| CLIENT ENROLLMENT | **PASS** (software foundation) |
| WIREGUARD | **PASS** (lifecycle/config software); interface UP = **EXTERNAL on physical** |
| NETWORK AUTHORITY | **PASS** |
| DEVICE REGISTRY | **PASS** |
| ENROLLMENT | **PASS** |
| REVOCATION | **PASS** |
| KEY ROTATION | **PASS** |
| FIREWALL | **PASS** (script: default DENY, CLIENT↛ADMIN, CLIENT↛CLIENT) |
| APPLICATION AUTH | **PASS** |
| CLIENT ISOLATION | **PASS** |
| CONNECTION MANAGER | **PASS** |
| HEARTBEAT | **PASS** |
| RECONNECT | **PASS** (no trading command replay) |
| COMMAND IDEMPOTENCY | **PASS** |
| SERVER REBOOT RECOVERY | **PASS** (durable registry) |
| NETWORK DIAGNOSTICS | **PASS** (honest EXTERNAL_BLOCKER) |
| CORE REGRESSION | **PASS** — 227/227 |
| PUBLIC MANAGEMENT EXPOSURE | **NONE** |
| PHYSICAL_i3 | **EXTERNAL_BLOCKER** |

## EXTERNAL BLOCKERS

- HISTORICAL_BASELINE
- CAPITAL_REAL_DEMO
- PHYSICAL_i3
- SERVER_EXTERNAL_REACHABILITY / possible SERVER_NOT_EXTERNALLY_REACHABLE (NAT/CGNAT — needs real public UDP endpoint / DDNS / port-forward; no fake workaround)
- WIREGUARD_INTERFACE up on real host
- CAPITAL_OUTBOUND / MARKET_FEED_OUTBOUND (live network)

## Operator path (physical next)

1. `SERVER/INSTALL_SERVER`
2. `SERVER/network/SETUP_PRIVATE_NETWORK`
3. `SERVER/network/APPLY_FIREWALL` → `UP_WIREGUARD` → `START_SERVER`
4. `ADMIN/INSTALL_ADMIN` + enrollment code
5. CLIENT enrollment code → app enroll → connected

**STOP** — no AAA Admin UI, no full Client UI, no Strategy/trading rule changes. Next: REAL PHYSICAL INSTALLATION (i3 / PC / test device).
