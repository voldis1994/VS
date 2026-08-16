# VS Repository Inventory — Architecture Phase

Generated for branch `cursor/vs-architecture-server-admin-client-0bd7` from P0 HEAD `d1f09f9`.

## Product boundaries

| Path | Role |
|------|------|
| `SERVER/` | Authoritative trading brain (i3 appliance) |
| `ADMIN/` | Management client (personal PC) — diagnostic only this phase |
| `CLIENT/` | End-client app source/build — structure only this phase |
| `apps/dashboard` | LEGACY web desk/panel (not native ADMIN/CLIENT) |
| `apps/market-core`, `apps/execution-service`, `libs/` | LEGACY C++ Market Reader |
| `cmake/`, `tests/`, `tools/` | SHARED/BUILD |

## SERVER layout (this phase)

```
SERVER/
  INSTALL_SERVER          # system install (once)
  START_SERVER            # validate + run (not install)
  STOP_SERVER
  STATUS_SERVER
  control-api/            # verified Node money path (git-renamed from apps/control-api)
  deploy/                 # systemd + boot (git-renamed from deploy/vs-core)
  config/                 # yaml policies (git-renamed from config/)
```

Money path code remains in `SERVER/control-api` — **behavior unchanged**. Internal `vs-core/` modules are KEEP; further folder-split into `core/strategy` etc. deferred until import graph can move without risk.

## Classification (summary)

| Component | Class | Action |
|-----------|-------|--------|
| control-api / vs-core money path | SERVER | MOVE (done → SERVER/control-api) |
| adminAgent | SERVER admin-service | KEEP + REFACTOR (snapshot/ping) |
| mobileApiV1 / mobileAuth | SERVER client-service | KEEP |
| hostTelemetry / coreTui / runTui | SERVER terminal | KEEP |
| boot / supervisor / readiness | SERVER supervisor | KEEP |
| capitalCom / capitalSessionManager | SERVER broker/capital | KEEP |
| dashboard Vite desk | LEGACY ADMIN web | KEEP under apps/ |
| dashboard client panel | LEGACY CLIENT web | KEEP; CLIENT/BUILD_CLIENT wraps |
| C++ libs / market-core | LEGACY | KEEP |

## External blockers (unchanged — never mock PASS)

- HISTORICAL_BASELINE
- CAPITAL_REAL_DEMO
- PHYSICAL_i3
