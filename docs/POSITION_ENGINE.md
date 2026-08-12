# Position Engine

`PositionManager` (`libs/position-engine`) owns open position lifecycle after a fill. Default horizon: **10 seconds** (`horizon_ns = 10e9`). Exit policy thresholds: `config/exit-policy.yaml`.

## Opening a position

`open_position(intent, fill_price, quantity, client, account)` sets:

- Links: `intent_id`, `setup_id`, `instrument`, `client_id`, `account_id`, `direction`  
- `entry_price` / `current_price` / `peak_favorable_price` = fill  
- `stop_loss` = intent `initial_invalidation`  
- `take_profit` = fill ± `expected_favorable_move`  

## PositionState metrics

| Field | Meaning |
|-------|---------|
| `mfe` | Maximum favorable excursion (price units from entry) |
| `mae` | Maximum adverse excursion |
| `peak_favorable_price` | Price at MFE |
| `peak_retention` | Current favorable / MFE (1.0 at peak) |
| `remaining_rr` | Remaining distance to TP / distance to SL |
| `current_pnl` | Mark-to-market PnL × quantity |
| `trailing_active` | Trailing flag |
| `horizon_ns` | Max hold window |

## MFE / MAE / peak update

`update_excursions(position, price)`:

1. Refresh `current_price` and `current_pnl` (long: price−entry; short: entry−price).  
2. Update MFE when favorable excursion increases; store `peak_favorable_price`.  
3. Update MAE when adverse excursion increases.  
4. If MFE > 0: `peak_retention = current_favorable / mfe`.  
5. Recompute `remaining_rr`.

## Evaluate path (PositionManager)

`evaluate()` refreshes excursions, then applies hard rules (before EV trail logic in ExitEngine):

| Condition | Action | ExitReason | Code |
|-----------|--------|------------|------|
| Long + down velocity + TrendDown (or short inverse) | ExitNow | ThesisFailure | `THESIS_FAILURE` |
| Price through stop | ExitNow | HardInvalidation | `HARD_INVALIDATION` |
| `peak_retention < 0.5` and MFE > 0 | ExitNow | PeakProtection | `PEAK_PROTECTION` |
| Price at/through take profit | TakeProfit | Target | `TARGET` |
| <1s horizon left and PnL ≈ flat vs MFE | ExitNow | TimeDecay | `TIME_DECAY` |
| Contradicting evidence + negative strength | ExitNow | ReversalEvidence | `REVERSAL_EVIDENCE` |
| `remaining_rr < 0.5` and MFE > 0 | ExitNow | Target | `REMAINING_RR_LOW` |
| Else | Hold | None | — |

Continuation/reversal probabilities seed from regime confidence for downstream ExitEngine EV comparison.

## Actions

`PositionAction`: `Hold`, `ExitNow`, `Trail`, `TakeProfit`.  
`ExitReason`: `None`, `ThesisFailure`, `HardInvalidation`, `PeakProtection`, `Target`, `TimeDecay`, `ReversalEvidence`, `EmergencyStop`.
