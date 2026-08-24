# Client + robot persistence

Clients, brokers, access-code hashes, and panel settings live in **Postgres**.

Restoring trading logic (e.g. back to #136 entry/exit) does **not** wipe clients —
DB volume, `robot_desk_persist`, and panel RUNNING flags stay intact.

## Survives restart

| What | Where |
|------|--------|
| Clients / brokers / markets | `vs_postgres_data` Docker volume |
| Panel RUNNING flag | `clients.panel_robot_requested` |
| Access code hash | `clients.access_code_hash` |
| Admin robot board units | `robot_desk_persist` + auto-restore on API boot |
| SQL backups | `data/backups/clients-*.sql` (each `VS.bat`) |

## Never do this

```bat
docker compose down -v
```

`-v` **deletes** the Postgres volume (all clients).

## After PC / VS.bat restart

1. Docker starts `vs_postgres_data` (same clients)
2. Control API logs `[persist] DB clients=N`
3. Robot desk auto-restores previously running units
4. Client panel subscriptions with RUNNING stay armed (pipeline fan-out)

## First upgrade

`tools/migrate-postgres-volume.mjs` copies an old `*_postgres_data` volume into `vs_postgres_data` once, so renaming the compose volume does not wipe clients.
