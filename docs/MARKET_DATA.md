# Market Data

## IMarketDataProvider

Interface in `libs/market-data` (`mr/market_data/provider.hpp`):

| Method | Behavior |
|--------|----------|
| `source_id()` | Stable `SourceId` for the feed |
| `start(callback)` | Begin emitting `MarketEvent`s to the callback |
| `stop()` | Halt emission |
| `is_connected()` | Connection / running flag |
| `health()` | `HealthStatus`: Healthy, Degraded, Unhealthy, Disconnected |

### Implementations

- **`ReplayMarketDataProvider`** — plays a preloaded `vector<MarketEvent>` (same interface).
- **`SyntheticMarketDataProvider`** — generates quote traffic for an instrument (paper/dev). Used by market-core in non-replay modes.
- **`ReplayEngine`** (`libs/replay`) — loads `.mrev` files and plays back at configured speed into the pipeline.

Feed definitions live in `config/feeds.yaml` (id, name, provider, instruments, `stale_threshold_ms`, etc.).

## MarketEvent

Defined in `mr/common/market_event.hpp`:

| Field | Meaning |
|-------|---------|
| `instrument`, `source` | Instrument and feed ids |
| `exchange_timestamp`, `provider_timestamp`, `receive_timestamp` | Clock trilogy (ns) |
| `bid` / `ask` / `last` | Optional prices |
| `bid_size` / `ask_size` / `trade_size` | Optional sizes |
| `type` | Quote, Trade, BookUpdate, Heartbeat, SessionStatus |
| `sequence` | Source sequence number |
| `quality` | Bitflags (`DataQualityFlag`) |

`NormalizedEvent` extends `MarketEvent` with `normalized_timestamp` and processing start/end stamps.

Quality flags include: Stale, OutOfOrder, Duplicate, SequenceGap, Crossed, WideSpread, MissingField, Divergent.

## Multi-feed

`FeedFusionEngine` ingests normalized events plus per-source health and maintains per-instrument:

- **Consensus** — mid price, spread, confidence, contributing source count  
- **Divergence** — max/mean divergence and most divergent source  
- **Lead/lag** — leader/lagger, lag ms, lead probability, directional agreement  
- **Source weights** — reliability weighting for fusion  

Default config enables two synthetic feeds (`synthetic-primary`, `synthetic-reference`) on instruments 1–3.

## Raw recording format (`.mrev`)

`RawEventRecord` (`libs/storage`) is a packed binary record:

- Magic: `0x4D524556` (`MREV`), version `1`
- Instrument, source, three int64 timestamps
- Event type + presence flags for bid/ask/last
- Prices, sizes, sequence, quality bitmask

`RawEventWriter` appends records (mutex-protected). `RawEventReader` streams them back. market-core records to `data/raw/events.mrev` by default when not in REPLAY mode (`--record` overrides path). Replay: `market-core.exe --mode REPLAY --file data\replay\events.mrev`.
