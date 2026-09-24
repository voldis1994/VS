# Edge measurement — closed trades & expectancy

## Purpose

Make “does the robot make money?” measurable. No daily loss limits, no % equity
entry blockers, no lot auto-sizing — **lot size stays operator-chosen**.

## Live decision source of truth

| Path | Role |
|------|------|
| **Capital Robot Desk (TypeScript)** | **SoT for live entries + Soft/Peak exits** (`structureEntry` → `robotDesk` → `exitManage`) |
| C++ `market-core` bridge | Client Panel confirmation / intent fanout; manage-only robots still exit via TS Soft/Peak |
| YAML `config/*-policy.yaml` | Documentation / C++ defaults — **not** the Capital desk SoT |

## Closed-trade ledger

On every desk / external close, `recordClosedTrade` writes:

- epic, direction, entry/exit, quantity (chosen lot)
- `pnl` (broker UPL when known) + `pnl_pts` (price favorable move)
- regime (frozen `entry_regime`), setup, exit_reason
- MFE / MAE / peak_retention / hold_ms
- source: `desk` | `external` | `pipeline`

Migration: `010_closed_trade_ledger.sql`.

## APIs

- `GET /api/trades` — closed rows (epic, setup, pts, …)
- `GET /api/trades/expectancy?window=7d|30d|90d|all` — buckets by regime / setup / exit / epic
- `POST /api/trades/replay/smoke` — offline TS-brain smoke on synthetic 10s bars

## Dashboard

**Trades** page shows rolling expectancy + closed ledger. Use **by regime** to
decide which regimes stay in desk calibration — do not add entry rate-limits.

## Offline replay

`replayStrategy(bars)` walks `classifyRegime` → `decideEntryWithStructure` →
`decideBestOutcomeExit` and returns the same expectancy shape. Unit tests:
`strategyReplay.test.ts`, `tradeLedger.test.ts`.

## Open at start (trade everything)

`TRADE_EVERYTHING_AT_START` — no soft entry blocks at boot:

- All regimes ON except UNKNOWN (incl. COMPRESSION / TRANSITION fade)
- No structure / story / flip / same-dir soft gates
- Auto-calibrate demotes losers every 5 closes

Still kept: SAFETY SL, one-trade-per-epic, stale-quote fail-closed. Lot unchanged.

## Auto-calibrate (ultimate)

From **robot START** (`entry_enabled`), desk watches closed trades and every
**5 closes** softly retunes Soft/Peak/Target + regime allowlist (demote ≤1
clear loser/cycle, keep ≥5 regimes). Lot unchanged. No daily/% entry blocks.

Status: **MAIN DASHBOARD** + desk panel **AUTO-CAL · LIVE BRAIN**, or
`GET /api/desk/auto-calibrate`.

After an **applied** calibrate: **3 min entry cooldown** (open trades still managed)
so the desk can settle knobs/regimes before the next setup.

## Explicitly out of scope

- Daily / weekly loss halts
- % equity or Kelly position sizing
- Any gate that blocks a valid structure entry because of “risk %”


## Broker SAFETY TP (auto-cal)

Capital **SAFETY TP** is driven by `safety_tp_rr` (multiple of SAFETY SL cushion),
not only Soft `target_abs`. Soft Target alone often does not move visible broker TP
on gold-like prices because SL≈0.2% dominates.

Auto-cal raises `safety_tp_rr` when winners are too small; **SL stays fixed**.
After an applied TP change, open positions are amended via Capital `PUT /positions`
(`profitLevel` only).

## Entry filter ladder (auto-cal)

`entry_filter_level` (desk cal, default **0**):

| Level | Soft filters |
|------:|--------------|
| 0 | OPEN — flip/structure/next-move off |
| 1 | Flip / same-dir lock |
| 2 | + structure / 1m bias / story knives |
| 3 | + same-dir next-move + RANGE spike block |

Robot **START** resets to 0. Auto-cal raises after bad closes, softens after clear positive expectancy. Never daily/% equity blocks.



## Auto-cal persistence

Session state is saved to `data/auto-calibrate-session.json` so closes/cycles
survive process restart. Robot **START** continues the watch (does not wipe).
Use **Reset watch** (or POST reset) for a fresh OPEN session.
Every close logs `AUTO-CAL watch n/5` even before a cycle.


## Core regimes never auto-OFF

Auto-cal will **not** turn off: RANGE, TREND_*, PULLBACK_*, EXPANSION,
COMPRESSION, TRANSITION. Only satellite regimes (BREAKOUT_*, FAILED_*,
REVERSAL_CANDIDATE) may soft-demote. Floor remains ≥5 enabled. Trading
cannot be starved by closing all liquid regimes.


## Per-client auto-cal

Each **client** has its own:
- auto-cal session (`data/auto-calibrate/client-{id}.json`)
- desk calibration knobs (`data/desk-calibration/client-{id}.json`)

API: pass `?client_id=` / body `client_id`. Dashboard uses the selected
client / account. Robots run inside that client scope — client A never
retunes client B.
