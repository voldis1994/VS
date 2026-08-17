# Acceptance report

**Environment:** cloud agent — physical i3/MSI/remote ISP **NOT TESTED** here.

## Automated

| Test | Result |
|------|--------|
| control-api vitest | RUN in CI/agent (see summary) |
| TESTS unit core + production | RUN |
| ADMIN connection | RUN |
| client-api auth boundary | RUN |
| Broker without secrets → CONFIG_REQUIRED | PASS (unit) |
| Kill switch denies risk | PASS (unit) |

## Physical (operator)

| ID | Test | Result |
|----|------|--------|
| A | Reboot i3 → auto start | NOT TESTED |
| B | i3 local monitor real status | NOT TESTED |
| C | MSI START_ADMIN LAN | NOT TESTED |
| D | CLIENT different ISP WG | NOT TESTED |
| E | CLIENT → ADMIN endpoint denied | NOT TESTED (unit covers client-api 403) |
| F | MSI off → CORE continues | NOT TESTED |
| G | CLIENT disconnect → CORE continues | NOT TESTED |
| H | Broker unavailable → TRADING_READY false, no fake broker | NOT TESTED (unit CONFIG_REQUIRED) |

Never fabricate physical PASS.
