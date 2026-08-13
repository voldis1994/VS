# Native 10-second OHLC

## Status

**YES** — Market Reader now builds its **own 10s OHLC** from live Capital quotes (not only Capital 1m).

## How it works

`FeatureEngine` (`libs/feature-engine`) buckets every mid price into **10-second** bars:

- `forming` — current open bucket (O/H/L/C + tick count)
- `last_closed` — previous completed 10s candle

Setup + Entry engines read `state.features.ohlc_10s`:

| Use | Rule |
|-----|------|
| Pullback setup | Last closed 10s bar against trend |
| Continuation | Last closed 10s bar with trend, body not exhausted |
| Anti late entry | Reject if last closed 10s body already ≥ ~0.08% in trade direction |

Capital **1m OHLC** remains an extra chase filter on the Node fanout path.

## Path

Quotes (~500ms) → FeatureEngine 10s OHLC → Setup/Evidence/Entry → pipeline intents
