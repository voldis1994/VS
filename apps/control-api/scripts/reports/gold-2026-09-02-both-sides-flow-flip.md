# Both-sides flow flip — live desk

Gold 2026-09-02 · lot 0.1 · sticky BUY must not sit through a SELL dump

| Mode | Trades | W/L | P&L | Wrong |
| --- | ---: | ---: | ---: | ---: |
| Entry v2 baseline | 8 | 6/2 | **£+2.54** | 2 |
| **This (flow flip)** | 8 | 6/2 | **£+2.54** | 2 |

## Live bug

Desk waited ARMED BUY / NONE (“no impulse yet”) while Capital showed a clear dump (e.g. 4441→4432). Watch already said SELL cont — sticky BUY never died on live flow, and opposite stayed unarmed under `no_impulse`.

## What changed

1. **Sticky kill on `liveFlow`** — DUMP kills sticky BUY; RALLY kills sticky SELL (no wait for impulse label).
2. **Flip into mid-leg CONT** — when sticky dies and `midLegImpulseArmOk` (room + persist + flow + not climax), arm opposite CONTINUATION immediately (`FLOW flip mid-leg SELL/BUY`).
3. **Kept** — `no_impulse` tip-blip ban, strict 2-bar candle confirm, mid-swing stickyWide only (no soft candle / no blank strongDump — those regressed day P&L to ~£1.7).

## Rejected on this day

| Idea | Day P&L |
| --- | ---: |
| Soft 1-bar CONT candle | ~£1.73 |
| strongDump mid-swing without stickyWide | ~£1.71 |
| Raw mid-leg impulse arm under `no_impulse` | ~£1.71–2.47 |
