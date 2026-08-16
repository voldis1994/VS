-- 014_market_intelligence.sql
-- Canonical market intelligence + decision audit tables.
-- Idempotent. Does not invent live data.

CREATE TABLE IF NOT EXISTS raw_ticks (
    id BIGSERIAL PRIMARY KEY,
    instrument VARCHAR(64) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    timestamp_source TIMESTAMPTZ NOT NULL,
    timestamp_receive TIMESTAMPTZ NOT NULL,
    bid DOUBLE PRECISION NOT NULL,
    ask DOUBLE PRECISION NOT NULL,
    mid DOUBLE PRECISION NOT NULL,
    spread DOUBLE PRECISION NOT NULL,
    sequence_id BIGINT,
    source_quality VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN',
    latency_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT raw_ticks_bid_ask_chk CHECK (ask >= bid AND bid > 0)
);
CREATE INDEX IF NOT EXISTS idx_raw_ticks_instr_ts ON raw_ticks(instrument, timestamp_source DESC);
CREATE INDEX IF NOT EXISTS idx_raw_ticks_provider ON raw_ticks(provider, timestamp_source DESC);

CREATE TABLE IF NOT EXISTS normalized_ticks (
    id BIGSERIAL PRIMARY KEY,
    raw_tick_id BIGINT REFERENCES raw_ticks(id) ON DELETE SET NULL,
    instrument VARCHAR(64) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    mid DOUBLE PRECISION NOT NULL,
    quality VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feed_health (
    id BIGSERIAL PRIMARY KEY,
    instrument VARCHAR(64) NOT NULL,
    as_of TIMESTAMPTZ NOT NULL,
    report JSONB NOT NULL,
    quality VARCHAR(32) NOT NULL,
    block VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feed_health_instr ON feed_health(instrument, as_of DESC);

CREATE TABLE IF NOT EXISTS candles_10s (
    instrument VARCHAR(64) NOT NULL,
    start_ts TIMESTAMPTZ NOT NULL,
    end_ts TIMESTAMPTZ NOT NULL,
    open DOUBLE PRECISION NOT NULL,
    high DOUBLE PRECISION NOT NULL,
    low DOUBLE PRECISION NOT NULL,
    close DOUBLE PRECISION NOT NULL,
    tick_count INTEGER NOT NULL,
    bid_open DOUBLE PRECISION NOT NULL,
    bid_high DOUBLE PRECISION NOT NULL,
    bid_low DOUBLE PRECISION NOT NULL,
    bid_close DOUBLE PRECISION NOT NULL,
    ask_open DOUBLE PRECISION NOT NULL,
    ask_high DOUBLE PRECISION NOT NULL,
    ask_low DOUBLE PRECISION NOT NULL,
    ask_close DOUBLE PRECISION NOT NULL,
    spread_min DOUBLE PRECISION NOT NULL,
    spread_max DOUBLE PRECISION NOT NULL,
    spread_mean DOUBLE PRECISION NOT NULL,
    source_count INTEGER NOT NULL,
    quality_score DOUBLE PRECISION NOT NULL,
    provenance JSONB NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (instrument, start_ts)
);

CREATE TABLE IF NOT EXISTS candles_aggregated (
    instrument VARCHAR(64) NOT NULL,
    timeframe_seconds INTEGER NOT NULL,
    start_ts TIMESTAMPTZ NOT NULL,
    end_ts TIMESTAMPTZ NOT NULL,
    ohlc JSONB NOT NULL,
    PRIMARY KEY (instrument, timeframe_seconds, start_ts),
    CONSTRAINT candles_agg_tf_chk CHECK (timeframe_seconds >= 10 AND timeframe_seconds % 10 = 0)
);

CREATE TABLE IF NOT EXISTS market_features (
    id BIGSERIAL PRIMARY KEY,
    instrument VARCHAR(64) NOT NULL,
    as_of TIMESTAMPTZ NOT NULL,
    features JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_states (
    id BIGSERIAL PRIMARY KEY,
    instrument VARCHAR(64) NOT NULL,
    as_of TIMESTAMPTZ NOT NULL,
    vector JSONB NOT NULL,
    label VARCHAR(64),
    status VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_market_states_instr ON market_states(instrument, as_of DESC);

CREATE TABLE IF NOT EXISTS setups (
    setup_id UUID PRIMARY KEY,
    strategy_id VARCHAR(128) NOT NULL,
    instrument VARCHAR(64) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    direction VARCHAR(8),
    conditions JSONB NOT NULL,
    all_pass BOOLEAN NOT NULL,
    market_state JSONB NOT NULL,
    feed_quality VARCHAR(32) NOT NULL,
    entry_reference DOUBLE PRECISION,
    invalidation_reference DOUBLE PRECISION,
    evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    block VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_decisions (
    id BIGSERIAL PRIMARY KEY,
    setup_id UUID REFERENCES setups(setup_id) ON DELETE SET NULL,
    strategy_id VARCHAR(128) NOT NULL,
    decision VARCHAR(32) NOT NULL,
    explanation JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sl_events (
    id BIGSERIAL PRIMARY KEY,
    trade_id UUID,
    order_id UUID,
    event_type VARCHAR(32) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exit_decisions (
    id BIGSERIAL PRIMARY KEY,
    trade_id UUID,
    candidates JSONB NOT NULL,
    chosen VARCHAR(32) NOT NULL,
    as_of TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broker_snapshots (
    id BIGSERIAL PRIMARY KEY,
    as_of TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extend candles TF check if table exists with restrictive CHECK — add S10 via new table above.
