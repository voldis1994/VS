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
8. **BE-lock:** after MFE ≥ Soft SL, Soft line moves to **true flat (0)** — not a profit harvest. Old 45%/5% Soft banked tiny Funds wins against full Soft losses. Cut when mid ≤ flat; while mid still green, require executable edge for magic-minus guard. Peak/Target/TimeDecay bank **≥ Soft HardInv** (1:1 min vs Soft loss).
9. **1m continue keeps Peak armed** — trail stays on.
10. **One desk for all markets:** Soft/Peak/Target abs knobs tuned at REF (~2000). Same candle regimes everywhere — abs pts scale with `entry/REF` (same % R:R on every epic).

One-shot upgrade: disk `desk-calibration.json` with scalp signature (`peak_mfe_abs < 2` + `hardinv_pct ≥ 0.0012`) is replaced by the new defaults (regimes kept).

## 2026-09-24 let-winners-run (Funds Gold 0.03)

Live sample still showed **+£0.01…£0.05** Peak/TimeDecay vs **−£0.09…£0.21** Soft. Knobs moved again:

| Knob | Was | Now |
|------|-----|-----|
| `hardinv_abs` | 2.2 | **2.0** |
| `peak_mfe_abs` | 3.0 | **4.5** |
| `peak_retention` | 0.65 | **0.75** |
| `peak_min_giveback_abs` | 0.85 | **1.2** |
| `target_abs` | 5.0 | **7.0** |
| TimeDecay min fav | 2.0 | **3.0** |

One-shot: disk `peak_mfe_abs < 4` + `target_abs < 6.5` → new defaults (regimes kept). Lot size unchanged.

## Verify

```bash
cd apps/control-api && npm test -- exitManage deskCalibration
```

Look for: `positive R:R Soft HardInv`, `asymmetry proof`, `BE-lock`, `1m continue does NOT disarm PeakProtect`.
