# VS Private Network — Physical Test (i3)

Software gates can be green while this remains **EXTERNAL_BLOCKER**.

Do **not** mark PHYSICAL_i3 PASS from Docker/localhost.

## Machines

| Role | Hardware |
|------|----------|
| VS SERVER | i3 |
| VS ADMIN | personal PC |
| VS CLIENT | test phone/device |

## Steps

1. On i3: `INSTALL_SERVER` → `SETUP_PRIVATE_NETWORK` → `APPLY_FIREWALL` → `UP_WIREGUARD` → `START_SERVER`
2. Confirm `STATUS_SERVER` shows WIREGUARD=UP and HEALTH=OK on `10.77.0.1` (not public bind)
3. If SERVER is behind NAT/CGNAT without UDP forward: record **SERVER_NOT_EXTERNALLY_REACHABLE** and required infrastructure (public endpoint / DDNS / port-forward) — do not invent a fake tunnel
4. ADMIN: `INSTALL_ADMIN`, enroll with code, Connection Manager uses `server_id=VS-CORE-01` (no `:3000` in UX)
5. CLIENT: enroll with code; confirm CLIENT cannot hit ADMIN; CLIENT A cannot hit CLIENT B
6. Revoke / rotate / reboot SERVER → reconnect without replaying trading commands

## Honest outcomes

- Software PASS ≠ physical PASS
- LIVE_READY stays false until Capital DEMO + physical proofs
