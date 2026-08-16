# VS — QUICK START

## SERVER / i3 Debian 13

```bash
sudo bash SERVER/install/INSTALL_SERVER.sh
sudo bash SERVER/install/HEALTHCHECK.sh
sudo bash SERVER/FINAL_ACCEPTANCE.sh
sudo bash SERVER/SHOW_DASHBOARD.sh
```

## ADMIN / MSI Windows 11

```bat
ADMIN\windows\INSTALL_ADMIN.bat
ADMIN\windows\START_ADMIN.bat
```

## CLIENT / remote Windows

```bat
CLIENT\windows\INSTALL_CLIENT.bat
CLIENT\VERIFY_CLIENT.bat
CLIENT\windows\START_CLIENT.bat
```

---

# Architecture

**i3 = VS CORE SERVER** (all brains). **MSI = ADMIN only**. **CLIENT = WireGuard → Client API**.

```
MARKET → INDICATORS → REGIME → STRATEGY → SIGNAL → RISK → EXECUTION → BROKER → CAPITAL.COM
```

See `DOCS/ARCHITECTURE.md`, `DOCS/LEGACY_AUDIT.md`, `DOCS/IMPLEMENTATION_REPORT.md`.

**LIVE trading defaults off.** No fake READY. No silent LIVE→DEMO fallback.

## Repository

```
VS/
├── SERVER/          # control-api, client-api, core/*, database, install, wireguard, systemd
├── ADMIN/           # Control Panel (Windows bats under ADMIN/windows)
├── CLIENT/          # Client + WireGuard enrollment consumers
├── SHARED/          # contracts / types
├── TESTS/           # unit / integration harness
├── DOCS/            # canonical documentation
└── legacy-review/   # frozen — not imported by production Node
```

Compatibility shims under old `SERVER/*-engine` paths re-export `SERVER/core/*`.
