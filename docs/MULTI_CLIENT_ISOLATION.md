# Multi-client / same-epic isolation

**Requirement:** N clients can run robots on the **same epic** (e.g. all Gold) at once without mixing entries, regimes, or positions.

## Verdict

**YES — concurrent same-epic robots work.** Each unit is `account_id + epic`.

| Layer | Isolation | Key |
|-------|-----------|-----|
| Robot session | **YES** | `robotIdFor(accountId, epic)` → `r{account}_{epic}` |
| Board cards / STOP | **YES** | per session id |
| Orders / deal_id / open_side | **YES** | per session + Capital account switch |
| Fan-out fills | **YES** | `(idempotency_key, client_id, account_id)` |
| Client STOP | **YES** | account-scoped only |
| Regime classifier (entry brain) | **YES** (fixed) | local `closedBars` + book `a{accountId}::{EPIC}` |
| Capital HTTP pool | **YES** per broker connection | `conn:{connectionId}` + mutex on acquire/switch |
| Desk calibration (regimes ON/OFF) | Desk-global | intentional shared policy |

## Same epic, three clients

```
Client A account 10 · GOLD → robot r10_GOLD · regime book a10::GOLD
Client B account 20 · GOLD → robot r20_GOLD · regime book a20::GOLD
Client C account 30 · GOLD → robot r30_GOLD · regime book a30::GOLD
```

Each has its own OHLC state, ENTRY WATCH, ticks, deal_id. Starting B does **not** stop or overwrite A.

## What we fixed (this change)

1. **Regime book was epic-only** — all GOLD robots shared one bar history → contaminated entry brain.  
   Now: classify from **local** `s.closedBars`; persist under **`a{accountId}::{EPIC}`**.
2. **Capital acquire/switch** serialized per `connectionId` so concurrent ticks don’t interleave account switches on one broker login.
3. Pipeline `notePipelineRegime` also stamps **per account** when executing a subscription.

## Still desk-global (by design)

- `enabled_regimes` / HardInv / Peak knobs — one CONTROL for the desk.
- Unscoped epic book may still exist for market aggregate display; robots **do not** use it for entry.

## Verify

1. Start robot Gold on client A and client B (same epic).
2. Board shows **two** cards (`r…_GOLD` different ids).
3. ENTRY WATCH / regime can differ per card.
4. STOP on A leaves B running.
