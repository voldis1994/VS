# Why 80% wins still lost money — and the fix

## The question

> Why is the loss always taken as large as possible, but profits get cut as small as possible — so I end with ~80% correct trades but a net minus?

## Root cause (pre-fix scalp profile)

Live manage path (`exitManage` + `robotDesk` + desk calibration):

| Path | Typical Gold size | Effect |
|------|-------------------|--------|
| PeakProtect after reverse 1m | bank **+0.45…+2.4** | many small winners |
| TimeDecay after 12m | bank **+0.75** | more tiny winners |
| Soft HardInv (`max(0.15%·P, 2)` × RANGE 1.6) | cut **−4…−6.4** after 25s+12s | few large losers |
| Broker SAFETY ~0.20% | **−4…−5+** if Soft never fires | catastrophic tail |

**Expectancy:** `0.8 × (+1) + 0.2 × (−5) ≈ −0.2` → high win-rate, negative PnL.

Peak also **disarmed on every green 1m continue**, so the trail was thrown away and the next reverse re-scalped a tiny giveback again.

## Fix (this change)

1. **`hardinv_abs` is a CAP** (~2.2), not a floor — Soft HardInv cannot run to 4–6pt on Gold %.
2. **Shorter Soft grace/confirm** (12s / 5s) — losers cut faster; wick debounce kept.
3. **RANGE mult 1.6 → 1.15** (still capped).
4. **Peak MFE floor ≥3pt** — no more micro-scalp winners vs Soft losses.
5. **Peak min giveback 0.85**, retention ~65% — lock more of a real leg.
6. **Target ≥ max(pct, abs, 4pt floor)** — Target stays above Soft HardInv.
7. **TimeDecay min fav ≥2pt** (and ≥0.9× Soft SL) — no +0.75 harvests.
8. **BE-lock:** after MFE ≥ Soft SL, Soft line moves to **~5% of Soft SL** (spread cushion only — not a profit harvest). Old 45% Soft banked tiny Funds wins (+£0.03) against full Soft losses (−£0.10). Cut only if mid ≤ lock; while mid still green, require **executable** bid/ask edge ≥ **25% of Soft SL** — otherwise HOLD (mid-flat + spread = magic-minus). Full Soft −SL still cuts real losers. Real winners = Peak/Target.
9. **1m continue keeps Peak armed** — trail stays on.
10. **One desk for all markets:** Soft/Peak/Target abs knobs tuned at REF (~2000). Same candle regimes everywhere — abs pts scale with `entry/REF` (same % R:R on every epic).

One-shot upgrade: disk `desk-calibration.json` with scalp signature (`peak_mfe_abs < 2` + `hardinv_pct ≥ 0.0012`) is replaced by the new defaults (regimes kept).

## Verify

```bash
cd apps/control-api && npm test -- exitManage deskCalibration
```

Look for: `positive R:R Soft HardInv`, `asymmetry proof`, `BE-lock`, `1m continue does NOT disarm PeakProtect`.
