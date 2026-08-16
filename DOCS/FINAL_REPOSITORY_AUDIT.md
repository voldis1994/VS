# Final repository audit

Generated for FINAL PHYSICAL PRODUCTION COMPLETION.

## Classification legend

- **KEEP** — canonical production
- **REWRITE** — keep role, fix implementation
- **MOVE_TO_LEGACY_REVIEW** — useful history, not started in production
- **DELETE** — safe to remove when confirmed unused (prefer move first)

## Major components

| Component | Path | Class | Notes |
|---|---|---|---|
| Control API | `SERVER/control-api` | KEEP | :3000 authoritative |
| Canonical v1 reads | `SERVER/control-api/src/routes/canonicalV1.ts` | KEEP | MSI contracts |
| Core engines | `SERVER/core/**` | KEEP | market-intelligence, strategies, supervisor |
| Database migrations | `SERVER/control-api/src/db/migrations` | KEEP | |
| i3 install | `SERVER/INSTALL_I3_SERVER`, `SERVER/install/*` | KEEP | |
| Boot / systemd | `SERVER/deploy/boot.sh` | KEEP | forces LAN bind |
| Live monitor | `SERVER/SHOW_LIVE_MONITOR.sh`, `vs-monitor` | KEEP | |
| ADMIN desktop | `ADMIN/desktop` | KEEP | :5188 only |
| ADMIN windows | `ADMIN/windows/*.ps1`, `ADMIN/*.bat` | KEEP | |
| CLIENT portal | served from control-api + `CLIENT/` | KEEP | WireGuard |
| Shared contracts | `SHARED/` | KEEP | |
| Tests | `TESTS/`, `**/…test.ts` | KEEP | |
| Legacy dashboards | `legacy-review/` | MOVE_TO_LEGACY_REVIEW | never START |
| dist packs | `dist/` | REWRITE | regenerate; do not hand-edit |
| Old :5173 tactical | under legacy-review | MOVE_TO_LEGACY_REVIEW | blocked by START |

## One production path

1. i3: `sudo bash SERVER/install/INSTALL_I3_SERVER.sh` → `vs-monitor`
2. MSI: `ADMIN\INSTALL_ADMIN.bat` → `ADMIN\START_ADMIN.bat` → :5188
3. CLIENT: WireGuard → i3 portal

No second Control API. No second ADMIN UI in production launchers.

## Fake-data scan (production)

Production server sources must not use Math.random for market/trading values.
Test fixtures under `*.test.ts` / `TESTS/fixtures` are allowed.
Unavailable → `UNAVAILABLE` / `UNKNOWN`, never invented ONLINE/LIVE.
