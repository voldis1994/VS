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

Status: desk panel **AUTO-CAL · ULTIMATE**, or `GET /api/desk/calibration` → `auto`.

## Explicitly out of scope

- Daily / weekly loss halts
- % equity or Kelly position sizing
- Any gate that blocks a valid structure entry because of “risk %”
