# WireGuard

- Interface: `wg0` / `vs0` (deploy-configured)
- Network: `10.77.0.0/24`
- Server: `10.77.0.1`
- UDP: `51820`

Env:

```
PUBLIC_HOST_OR_IP=<reachable WAN DNS/IP>
WIREGUARD_PORT=51820
```

NAT: `WAN UDP 51820 → VS-CORE-01 LAN IP UDP 51820`.

Scripts: `SERVER/wireguard/scripts/*` → `SERVER/network/*`.

Verify: handshake + RX/TX + CLIENT API — ping alone is insufficient (`CLIENT/VERIFY_CLIENT.bat`).
