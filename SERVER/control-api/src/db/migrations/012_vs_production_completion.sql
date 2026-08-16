-- 012_vs_production_completion.sql
-- Additional durable entities for production completion pass.
-- Idempotent CREATE IF NOT EXISTS. Does not drop existing data.

CREATE TABLE IF NOT EXISTS schema_versions (
    id SERIAL PRIMARY KEY,
    schema_name VARCHAR(128) NOT NULL DEFAULT 'vs',
    version VARCHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (schema_name, version)
);

CREATE TABLE IF NOT EXISTS system_state (
    key VARCHAR(128) PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_services (
    service_name VARCHAR(128) PRIMARY KEY,
    state VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN',
    detail TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT system_services_state_chk CHECK (
      state IN ('STARTING','READY','DEGRADED','BLOCKED','FAILED','STOPPING','STOPPED','UNKNOWN','CONFIG_REQUIRED')
    )
);

CREATE TABLE IF NOT EXISTS kill_switch (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    active BOOLEAN NOT NULL DEFAULT false,
    reason TEXT,
    changed_by VARCHAR(128),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO kill_switch (id, active, reason, changed_by)
VALUES (1, false, 'default inactive', 'migration')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS regime_history (
    id BIGSERIAL PRIMARY KEY,
    symbol VARCHAR(64) NOT NULL,
    regime VARCHAR(64) NOT NULL,
    confidence NUMERIC(8,6) NOT NULL DEFAULT 0,
    evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_regime_history_symbol_time ON regime_history(symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS signals (
    signal_id UUID PRIMARY KEY,
    symbol VARCHAR(64) NOT NULL,
    direction VARCHAR(8) NOT NULL,
    strategy VARCHAR(128) NOT NULL,
    strategy_version VARCHAR(64) NOT NULL DEFAULT '1',
    regime VARCHAR(64) NOT NULL,
    regime_confidence NUMERIC(8,6) NOT NULL DEFAULT 0,
    timeframe VARCHAR(8) NOT NULL,
    entry_reference NUMERIC(18,8),
    stop_reference NUMERIC(18,8),
    target_reference NUMERIC(18,8),
    confidence NUMERIC(8,6) NOT NULL DEFAULT 0,
    evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    invalidated_at TIMESTAMPTZ,
    CONSTRAINT signals_direction_chk CHECK (direction IN ('LONG','SHORT','NONE'))
);

CREATE TABLE IF NOT EXISTS risk_decisions (
    id BIGSERIAL PRIMARY KEY,
    decision VARCHAR(8) NOT NULL,
    reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    client_id INTEGER,
    account_id INTEGER,
    symbol VARCHAR(64),
    signal_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT risk_decisions_chk CHECK (decision IN ('ALLOW','DENY'))
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id BIGSERIAL PRIMARY KEY,
    status VARCHAR(32) NOT NULL,
    detail TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    CONSTRAINT reconciliation_runs_status_chk CHECK (
      status IN ('STARTED','COMPLETED','FAILED','PENDING')
    )
);

CREATE TABLE IF NOT EXISTS reconciliation_differences (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
    kind VARCHAR(64) NOT NULL,
    local_ref TEXT,
    broker_ref TEXT,
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backup_runs (
    id BIGSERIAL PRIMARY KEY,
    path TEXT NOT NULL,
    status VARCHAR(32) NOT NULL,
    bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verified_at TIMESTAMPTZ,
    CONSTRAINT backup_runs_status_chk CHECK (status IN ('STARTED','COMPLETED','FAILED','VERIFIED'))
);

CREATE TABLE IF NOT EXISTS restore_runs (
    id BIGSERIAL PRIMARY KEY,
    backup_id BIGINT REFERENCES backup_runs(id),
    status VARCHAR(32) NOT NULL,
    confirmed_by VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT restore_runs_status_chk CHECK (status IN ('STARTED','COMPLETED','FAILED','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS update_history (
    id BIGSERIAL PRIMARY KEY,
    from_version VARCHAR(64),
    to_version VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT update_history_status_chk CHECK (
      status IN ('STAGED','APPLIED','FAILED','ROLLED_BACK')
    )
);

CREATE TABLE IF NOT EXISTS configuration_versions (
    id BIGSERIAL PRIMARY KEY,
    config_key VARCHAR(128) NOT NULL,
    version VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_events (
    id BIGSERIAL PRIMARY KEY,
    audience VARCHAR(32) NOT NULL,
    client_id INTEGER,
    title VARCHAR(255) NOT NULL,
    body TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS market_feed_status (
    symbol VARCHAR(64) PRIMARY KEY,
    state VARCHAR(32) NOT NULL DEFAULT 'STOPPED',
    bid NUMERIC(18,8),
    ask NUMERIC(18,8),
    mid NUMERIC(18,8),
    spread NUMERIC(18,8),
    source_timestamp TIMESTAMPTZ,
    received_timestamp TIMESTAMPTZ,
    quality VARCHAR(32) NOT NULL DEFAULT 'UNAVAILABLE',
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT market_feed_state_chk CHECK (
      state IN ('STOPPED','CONNECTING','LIVE','DEGRADED','STALE','DISCONNECTED','ERROR')
    )
);

INSERT INTO schema_versions (schema_name, version)
VALUES ('vs', '012_vs_production_completion')
ON CONFLICT (schema_name, version) DO NOTHING;

INSERT INTO system_state (key, value)
VALUES ('live_trading_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
