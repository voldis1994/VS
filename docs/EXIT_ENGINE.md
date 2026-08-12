# Exit Engine

`ExitEngine` (`libs/exit-engine`) chooses among hold / exit / trail / take-profit by comparing expected values, then applies safety overrides. It complements the rule-based checks in `PositionManager::evaluate`.

## Interface

```cpp
PositionDecision decide(
    const PositionState& position,
    const MarketState& state,
    const RegimeState& regime,
    const EvidenceReport& evidence,
    double continuation_prob,
    double reversal_prob);
```

## EV comparison

Given remaining favorable distance (to TP) and adverse distance (to SL):

| Metric | Formula (conceptually) |
|--------|------------------------|
| `ev_exit` | Current PnL (realize now) |
| `ev_hold` | PnL + continuation×favorable_remaining − reversal×adverse_remaining |
| `ev_trail` | `mfe × peak_retention` |
| `ev_take_profit` | Current PnL (target harvest proxy) |

Selection:

1. Start with **Hold** if `ev_hold` is best.  
2. Prefer **ExitNow** (`Target`) if `ev_exit` wins.  
3. Prefer **Trail** if `ev_trail` wins and MFE > 0.  
4. Prefer **TakeProfit** (`Target`) if that EV wins.  

Probabilities are passed through on the decision for telemetry/audit.

## Safety overrides

Applied after EV ranking:

| Condition | Action | Reason | Notes |
|-----------|--------|--------|-------|
| `state.data_quality.stale` | ExitNow | EmergencyStop | Reason code `STALE_FEED` |
| Contradicting evidence and `reversal_prob > 0.7` | ExitNow | ReversalEvidence | Protects against flipped thesis |

## Exit reasons (full set)

Shared with position engine (`ExitReason`):

- **ThesisFailure** — regime/velocity contradicts trade direction  
- **HardInvalidation** — stop breached  
- **PeakProtection** — gave back too much of MFE (`peak_retention < 0.5`)  
- **Target** — TP hit, EV exit preferred, or remaining R:R too low  
- **TimeDecay** — horizon nearly exhausted without progress  
- **ReversalEvidence** — contradicting evidence sequence  
- **EmergencyStop** — stale/unhealthy feed  

## Policy config

`config/exit-policy.yaml`:

- `horizon_ms: 10000`  
- `peak_retention_threshold: 0.5`  
- `remaining_rr_threshold: 0.5`  
- `time_decay_seconds: 1.0`  
- Toggles for thesis failure and reversal evidence  
- Allowed actions: HOLD, EXIT_NOW, TRAIL, TAKE_PROFIT  

execution-service evaluates PositionManager then ExitEngine after fills to log the chosen action/reason.
