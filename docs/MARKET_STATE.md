# Market State

`MarketStateEngine` (`libs/market-state`) builds versioned snapshots from features, feed fusion, and data quality. Each update allocates a `SnapshotId` and stores latest-per-instrument plus historical snapshot lookup.

## MarketState

| Field | Type | Purpose |
|-------|------|---------|
| `snapshot_id` | `SnapshotId` | Immutable snapshot key |
| `instrument` | `InstrumentId` | Target instrument |
| `timestamp` | `Timestamp` | Snapshot time |
| `direction` | `DirectionState` | Directional pressure |
| `structure` | `StructureState` | Range / breakout geometry |
| `volatility` | `VolatilityState` | Compression / expansion |
| `flow` | `FlowState` | Buy/sell pressure and intensity |
| `liquidity` | `LiquidityState` | Spread and imbalance |
| `multi_feed` | `MultiFeedState` | Consensus / divergence / lead-lag |
| `data_quality` | `DataQualityState` | Aggregate feed health |
| `latency` | `LatencyState` | Feed and processing latency |
| `features` | `FeatureSnapshot` | Full feature vector |

## Component details

### DirectionState
- `direction` — Flat / Long / Short  
- `pressure`, `confidence` — signed pressure and confidence  

### StructureState
- `range_position`, `breakout_strength`  
- `in_range`, `breakout_active`  

### VolatilityState
- `level`, `trend`  
- `compressed`, `expanding`  

### FlowState
- `buy_pressure`, `sell_pressure`, `net_flow`, `trade_intensity`  

### LiquidityState
- `spread`, `spread_velocity`, `imbalance`, `absorption`  

### MultiFeedState
- `consensus_confidence`, `divergence`, `lead_lag_probability`, `active_sources`  

### DataQualityState
- `overall_score` (1.0 healthy)  
- `stale`, `degraded`, `unhealthy_sources`  

### LatencyState
- `feed_latency_ms`, `processing_latency_ms`  

## FeatureSnapshot (embedded)

Produced by `FeatureEngine` on log-spaced windows (10ms–60s): price dynamics, volatility, microstructure, structure, multi-feed, and quality features. Downstream regime, setup, evidence, and entry engines consume Market State rather than raw ticks.

## Update path

```
FeatureSnapshot + FeedConsensus + FeedDivergence + LeadLagState + DataQualityEngine
  → MarketStateEngine::update → MarketState
```

API/dashboard surfaces expose summarized market state via `/api/market/instruments` and WebSocket `market_update` messages.
