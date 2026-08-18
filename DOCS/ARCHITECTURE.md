# Architecture (as implemented)

ONE VS CORE on i3 Debian. ADMIN and CLIENT are two authorization doors, not two servers.

```
                         i3 DEBIAN
                    ┌─────────────────────┐
                    │       VS CORE       │
                    └──────────┬──────────┘
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
          SERVER MONITOR    ADMIN API      CLIENT HTTPS
           native Linux        :3000            :443
                │              │                │
            i3 screen          ▼                ▼
                          VS Admin.exe      CLIENT WEB
                           (MSI / LAN)       browser
```

ONLY CLIENT = WEB.

```
MSI Windows → PALAID.bat / START_MSI.bat → VS Admin.exe → http://<i3-LAN>:3000
CLIENT browser → https://<stable-host>/ → :443 → Control API client routes only
```

## Ports

| Port | Role |
|------|------|
| 3000 | Private Control / ADMIN API (i3, LAN / WireGuard only) |
| 443 | Public CLIENT HTTPS |
| 5432 | PostgreSQL internal |
| 6379 | Redis internal |
| 5188 | **removed from production** |
| 5173 | **removed from production** |

ADMIN desktop does not listen on any TCP port.

## Config precedence (MSI)

1. `ADMIN/config/SERVER_IP.txt` (operator-pinned i3 IPv4)
2. LAN bootstrap token from `/api/v1/admin/lan-bootstrap`
3. `ADMIN/config/control-panel.env`

No subnet scan. Wrong IP fails identity (`service=VS-CORE`, `server_id=VS-CORE-01`).

## Config precedence (i3)

1. `/var/lib/vs-server/server.env` (runtime, not git)
2. `/etc/vs/client-url` (stable public CLIENT URL — never overwritten by `git pull`)
3. `/etc/vs/tls/*.pem` (optional TLS for :443)
4. Control API env from systemd `EnvironmentFile`

## START / STOP (client)

- `START` — activate this client's server-side session (market + lot).
- `STOP_NEW_ENTRIES` (default STOP) — stop new entries; open positions stay managed.
- `CLOSE_AND_STOP` — close broker positions then stop entries.

## UI technologies

| Surface | Technology |
|---------|------------|
| VS Server Monitor | Python 3 + PySide6 on i3 (TUI fallback if headless) |
| VS Admin | Python 3 + PySide6 packaged as `VS Admin.exe` |
| VS CLIENT | HTTPS web app (`CLIENT/web`) |

## Old files

`old version/` is an archive. Production source must not reference it.
