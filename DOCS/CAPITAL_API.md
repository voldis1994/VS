# Capital.com

Adapter: `SERVER/core/broker/capital/`.

`CAPITAL_ENV=LIVE|DEMO` — **explicit only**. No silent LIVE→DEMO fallback.

Without credentials: `CONFIG_REQUIRED` (never CONNECTED).

Safe probes (no trades):

```bash
bash SERVER/core/broker/capital/vs-broker-status
bash SERVER/core/broker/capital/vs-broker-test-auth
bash SERVER/core/broker/capital/vs-broker-test-market
```

Secrets only on VS-CORE-01. Never in ADMIN/CLIENT git or bundles.
