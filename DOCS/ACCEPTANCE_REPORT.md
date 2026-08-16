# Acceptance report

**Environment note:** This cloud agent cannot power-cycle the physical i3/MSI or a remote client ISP. Results below are from **repository tests** and scripts. Physical gates are operator-run.

## Automated (this pass)

| Gate | Result |
|------|--------|
| control-api vitest | PASS (306) |
| TESTS unit (core + production-completion) | PASS |
| ADMIN connection tests | PASS (18) |
| Broker without secrets → CONFIG_REQUIRED | PASS |
| Kill switch denies risk | PASS |
| Regime hysteresis / strategy eligibility | PASS |
| Market feed duplicate rejection | PASS |
| LIVE default false | PASS (unchanged fail-closed) |

## Operator physical commands

**i3**

```bash
sudo bash SERVER/install/INSTALL_SERVER.sh
sudo bash SERVER/FINAL_ACCEPTANCE.sh
sudo bash SERVER/SHOW_DASHBOARD.sh
```

**MSI**

```bat
ADMIN\INSTALL_ADMIN.bat
ADMIN\START_ADMIN.bat
ADMIN\FINAL_ACCEPTANCE.bat
```

**Remote CLIENT**

```bat
CLIENT\VERIFY_CLIENT.bat
CLIENT\FINAL_ACCEPTANCE.bat
```

## Known external configuration required

- Capital.com credentials on VS-CORE-01
- `PUBLIC_HOST_OR_IP` + UDP 51820 port forward for remote clients
- `API_ADMIN_TOKEN` / DB secrets

## Known blockers to live trading

- `LIVE_TRADING_ENABLED=false` by default (intentional)
- Broker session proof requires credentials + operator verification
- Reconciliation must be clean before TRADING_READY
