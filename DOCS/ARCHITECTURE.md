# VS Architecture

## Physical products

1. **VS CORE SERVER** — i3 Debian 13 (`VS-CORE-01`) — sole trading brain  
2. **VS ADMIN** — MSI Windows 11 — Control Panel only (LAN)  
3. **VS CLIENT** — customer Windows — WireGuard → Client API  

## Data flow

```
CAPITAL.COM
    ↕ REST/WS
BROKER GATEWAY (SERVER/core/broker)
    ↕
VS CORE (i3)
  market-data → indicators → regime → strategy → signal → risk → execution
  positions / reconciliation / audit / incidents
  PostgreSQL + Redis
  CONTROL API  ←LAN←  MSI ADMIN
  CLIENT API   ←WG←   CLIENT (10.77.0.1)
  local monitor (optional UI; closing does not stop server)
```

## Readiness

| Flag | Meaning |
|------|---------|
| PROCESS_READY | systemd + Control API process |
| SYSTEM_READY | process + DB + Client API reachable |
| TRADING_READY | system + broker + market + risk + execution + reconciliation gates |

Broker credentials absent ⇒ `BROKER_READY=false`, `TRADING_READY=false`. Server is **not** “dead”.

## Authority

Authoritative state lives only on i3. MSI/CLIENT offline must not stop VS CORE.

## Repository map

See `DOCS/LEGACY_AUDIT.md` and tree under `SERVER/core/`, `SERVER/control-api/`, `SERVER/client-api/`.
