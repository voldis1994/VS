# old version/ — legacy archive

This tree is **history only**. Production does not import, execute, or start anything here.

| Folder | What it holds |
|---|---|
| `architecture/legacy-review` | Pre-rebuild tactical desk, C++ engines, old docs |
| `deploy/DEPLOY` | Duplicate packaging copies of ADMIN/CLIENT/SERVER scripts |
| `admin/` | Extra Windows/Unix start scripts (`CONNECT_FORCE`, `:5173` control panel, …) |
| `server/` | Duplicate i3 aliases (`1_START_I3`, `LAUNCH_ALL`, stub `client-api`) |
| `client/` | Local Vite preview start (customers use HTTPS :443) |
| `scripts/` | Duplicate `START_I3.sh`, `FORCE_I3_LAN`, release packagers |
| `docs/` | Superseded acceptance/audit reports |

Canonical production:

- i3: `START_I3`
- MSI: `START_MSI.bat`
- Client: HTTPS URL in `/etc/vs/client-url`
