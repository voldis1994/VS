# Market data pipeline — VS CORE

Canonical path: **i3 SERVER only**. ADMIN/CLIENT never invent ticks.

## Pipeline

```
FEED adapter(s)
  → raw tick
  → validate (bid/ask/mid/spread/timestamp)
  → normalize + symbol map
  → dedupe / order
  → canonical tick
  → 10-second OHLC (SERVER/core/market-intelligence/src/ohlc10s.ts)
  → market intelligence / features / state
  → strategy evaluation
```

## Rules

- Production code must not use `Math.random`, fake ticks, or demo candle generators.
- Missing feed → `UNAVAILABLE` / incident — never fabricate mid.
- Multi-feed: track connected, last tick, latency, bid/ask/spread, staleness, provenance.
- Cross-feed disagreement is recorded; invalid feeds are not silently averaged.
- Symbol naming differs by provider — use mapping tables, do not assume identity.

## Persistence

- `ticks` / feed health rows
- `candles_10s` — deterministic UTC buckets (:00,:10,…); reproducible from stored ticks
- quality flags + source coverage on each candle

## API (admin)

- `GET /api/v1/market/status`
- `GET /api/v1/market/feeds`
- `GET /api/v1/market/ohlc?symbol=`
- `POST /api/v1/market/feeds/validate` (intelligence core)

## Feeds

Configured adapters (e.g. Capital.com) live under SERVER core/broker + robot reader paths.
Credentials only in `/var/lib/vs-server` / `/etc/vs` — never committed.
