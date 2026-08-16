# Acceptance report

**Environment note:** This cloud agent cannot power-cycle the physical i3/MSI or a remote client ISP. Results below are from **repository tests** and **architecture gates**. Physical acceptance remains operator-run using the commands in `DOCS/SERVER_INSTALL.md` / `DOCS/ADMIN_INSTALL.md`.

## Automated (executed in this session)

| Gate | Result |
|------|--------|
| Indicator / tick validation / regime NO_TRADE / risk sizing / supervisor trading≠process | PASS (`TESTS` 10/10) |
| LIVE default false / trading_ready false when live off | PASS (unit) |
| No Math.random market ticks in new modules | PASS (code review) |

## Physical (operator must confirm on hardware)

| Gate | Status |
|------|--------|
| i3 reboot → vs-server + monitor autostart | Operator: `STATUS_SERVER` + `systemctl status vs-server-monitor` |
| MSI INSTALL/START over LAN | Operator: prior success path `TRANSPORT=LAN` |
| Remote CLIENT via WireGuard | Operator: different ISP |
| TRADING_READY true | **Must stay false** until Capital + reconcile + operator auth |

## Known blockers to “trading done”

- Broker session proof not auto-set to connected in supervisor (intentional fail-closed)
- Reconciliation gate defaults pending
- Operator authorization required
