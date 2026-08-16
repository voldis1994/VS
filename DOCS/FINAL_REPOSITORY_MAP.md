# Final Repository Map

## Top-level

| Directory | Purpose | Entry point | Runtime location (i3) | Owner machine |
|-----------|---------|-------------|----------------------|---------------|
| `SERVER/` | Authoritative VS CORE | `install/INSTALL_SERVER.sh`, `deploy/boot.sh` | `/opt/vs-server` | i3 |
| `ADMIN/` | MSI Control Panel only | `INSTALL_ADMIN.bat` → `desktop` Vite UI | `%LOCALAPPDATA%\VS\admin` config | MSI |
| `CLIENT/` | Customer app + WG | `INSTALL_CLIENT.bat` / `START_CLIENT.bat` | Customer PC + WG tunnel | Customer |
| `SHARED/` | Contracts/types | imported by apps/tests | n/a (source) | all |
| `DEPLOY/` | Deploy asset index (symlinks) | `DEPLOY/debian/INSTALL_SERVER.sh` | n/a | ops |
| `TESTS/` | Automated + physical | `npm test` | CI / agent | all |
| `DOCS/` | Documentation | README links | n/a | ops |
| `legacy-review/` | Archive only | never | never | none |
| `scripts/` | Release packaging | `BUILD_RELEASE.sh`, `BUILD_CLIENT_PACKAGE.sh` | build host | ops |

## SERVER subsystems

| Path | Purpose | Dependencies |
|------|---------|--------------|
| `control-api/` | HTTP ADMIN+CLIENT APIs, appliance, presence, network, trading | Postgres, Redis, core libs |
| `client-api/` | Explicit CLIENT boundary helpers/tests | control-api contracts |
| `core/` | Market/indicators/regime/strategy/signal/risk/execution/broker/supervisor | pure + adapter |
| `database/migrations/` | Schema authority | PostgreSQL |
| `monitor/` | Graphical local panel | control-api `/api/v1/server/monitor` |
| `network/` | WireGuard + firewall scripts | Linux WG |
| `install/` | Idempotent Debian installer | root on Debian 13 |
| `deploy/systemd/` | `vs-core.service`, `vs-server-monitor.service` | systemd |

## ADMIN

| Path | Purpose |
|------|---------|
| `desktop/` | React Control Panel |
| `app/` | install/start CLI (tsx) |
| `connection/` | LAN discover + enroll |
| `windows/` | `.bat` / `.ps1` installers |

## CLIENT

| Path | Purpose |
|------|---------|
| `desktop/` | React customer UI |
| `connection/` | Enrollment helper |
| `windows/` | Install / start / verify |

## Data paths (installed i3)

| Path | Role |
|------|------|
| `/opt/vs-server` | Application |
| `/etc/vs-server` | Configuration |
| `/var/lib/vs-server` | Persistent data + secrets |
| `/var/log/vs-server` | Logs |
