# Regimes

Regime classification is performed by `RegimeEngine` (`libs/regime-engine`) from the latest `MarketState`. Configuration: `config/regimes.yaml` (primary horizon 10s, transition smoothing, confidence threshold).

## Regime types

| Regime | Name | Typical conditions |
|--------|------|--------------------|
| `Unknown` | UNKNOWN | Insufficient structure |
| `Range` | RANGE | `in_range`, no strong trend |
| `TrendUp` | TREND_UP | Positive persistence + velocity |
| `TrendDown` | TREND_DOWN | Negative persistence + velocity |
| `PullbackUptrend` | PULLBACK_UPTREND | Prior TrendUp with adverse velocity |
| `PullbackDowntrend` | PULLBACK_DOWNTREND | Prior TrendDown with adverse velocity |
| `Compression` | COMPRESSION | Compressed volatility in range |
| `Expansion` | EXPANSION | Expanding volatility |
| `BreakoutUp` | BREAKOUT_UP | Expansion + breakout + up trend |
| `BreakoutDown` | BREAKOUT_DOWN | Expansion + breakout + down trend |
| `FailedBreakoutUp` | FAILED_BREAKOUT_UP | Reserved / classified via structure features |
| `FailedBreakoutDown` | FAILED_BREAKOUT_DOWN | Reserved / classified via structure features |
| `ReversalCandidate` | REVERSAL_CANDIDATE | High `reversal_candidate` feature |
| `Transition` | TRANSITION | Leaving a prior non-range regime without clear next state |

## Classification logic (summary)

`classify()` inspects feature persistence/velocity plus volatility and structure flags:

1. Compression if compressed and in-range  
2. Breakout up/down if expanding, breakout active, and trending  
3. Expansion if expanding without clean breakout direction  
4. Pullback variants when prior trend persists but velocity flips  
5. Trend up/down  
6. Reversal candidate from structure feature  
7. Range  
8. Otherwise Transition (if previous was meaningful) or Unknown  

## RegimeState

- `current` / `previous`  
- `confidence` (from direction confidence)  
- `transition_probability`  
- `since` — timestamp of last change  

## Transitions

On regime change, a `RegimeTransition` `{from, to, timestamp, probability}` is appended (history capped at 100 per instrument). Downstream:

- **SetupEngine** — discovers CONTINUATION / PULLBACK / BREAKOUT candidates from regime context  
- **EntryEngine** — includes regime name in human explanation  
- **PositionManager / ExitEngine** — use regime confidence and adverse regime flips for thesis failure  

Primary decision horizon aligns with `primary_horizon_ms: 10000` in config.
