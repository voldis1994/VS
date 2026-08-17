# Architecture (as implemented)

ONE VS CORE on i3 Debian. ADMIN and CLIENT are two authorization doors, not two servers.

```
INTERNET → market feeds → i3 VS-CORE-01
                         ├─ Control API  :3000  (LAN / MSI only)
                         ├─ Client GW    :443   (public HTTPS)
                         ├─ PostgreSQL   :5432  (localhost)
                         └─ Redis        :6379  (localhost)

MSI Windows → START_MSI.bat → 127.0.0.1:5188 UI → http://<i3-LAN>:3000
CLIENT browser → https://<stable-host>/ → :443 → Control API client routes only
```

## Config precedence (MSI)

1. `ADMIN/config/SERVER_IP.txt` (operator-pinned i3 IPv4)
2. LAN bootstrap token from `/api/v1/admin/lan-bootstrap`
3. `ADMIN/config/control-panel.env`
4. `ADMIN/desktop/public/runtime-config.js` (written at start, gitignored)

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

## Old files

`old version/` is an archive. Production source must not reference it.
