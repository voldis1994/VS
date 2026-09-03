# Both-sides flow flip — live desk

Gold 2026-09-02 · lot 0.1 · sticky BUY must not sit through a SELL dump

| Mode | Trades | W/L | P&L | Wrong |
| --- | ---: | ---: | ---: | ---: |
| Entry v2 baseline | 8 | 6/2 | £+2.54 | 2 |
| **This (flow flip + mid-swing soft)** | 8 | 5/3 | **£+2.61** | 3 |

## Live bugs

1. Desk waited ARMED BUY / NONE while Capital showed a clear dump (e.g. 4441→4432).
2. Later: **ARMED mid-swing SELL** still blocked on `need closed red 1m confirm` after **5 reds + pause doji** (`O≈C`).

## What changed

1. **Sticky kill on `liveFlow`** — DUMP kills sticky BUY; RALLY kills sticky SELL.
2. **Flip into mid-leg CONT** when sticky dies and `midLegImpulseArmOk`.
3. **Soft candle on mid-swing / flow-flip only** — if dump already proven (≥3 reds + ≥2pt drop in last 5), a pause doji does **not** block SELL. One-blip CONT stays strict. Spike candles still wait next bar.

## Kept

- `no_impulse` tip-blip ban
- Strict FADE / tip CONTINUATION candle rules
