# Trading fixes — SL cushion, room to run, real setups

## Problems addressed

1. **SL too tight** — was dealing-rules *minimum* → hit on almost every trade  
2. **Exits too fast** — manage TP/peak/time cut winners before a real move  
3. **Random / late entries** — forced first BUY + mid-noise; chasing end of move  

## Changes

### SAFETY SL (cushion)
- ~**0.25%** of price, at least **3×** Capital min stop  
- Applied on Robot Desk `enterTrade` and Client Panel `intentFanout`  
- Not the legal minimum

### Manage exits (more room)
- TP ~**0.35%** (was ~0.08%)  
- Soft SL ~**0.22%** (was ~0.12%)  
- Peak protection only after meaningful MFE; allow deeper giveback  
- TimeDecay after **8 min** (was 3)

### Real ~10s setups
- EntryEngine: enter on **setup sight** (Building ≥0.5 conf) or Confirmed  
- Reject **LATE_MOVE** extremes  
- Min probability **0.72** (selective / high precision)  
- Evidence: strong single confirmation OR multi-evidence  
- Setup detectors skip range extremes  
- Capital **1m OHLC** gate: skip if last minute candle already ran in trade direction  
- Robot desk: no random first BUY; stronger mid impulse threshold  

## Operator

Restart with `VS_RESTART.exe` / pull `main` so market-core + control-api pick up binaries/code.
