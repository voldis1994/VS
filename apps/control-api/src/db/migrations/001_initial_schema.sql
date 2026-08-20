-- Users and clients
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'operator',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broker_connections (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    broker_name VARCHAR(100) NOT NULL,
    environment VARCHAR(50) NOT NULL DEFAULT 'demo',
    identifier VARCHAR(255),
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_credential_metadata (
    id SERIAL PRIMARY KEY,
    broker_connection_id INTEGER NOT NULL REFERENCES broker_connections(id) ON DELETE CASCADE,
    credential_type VARCHAR(50) NOT NULL,
    ciphertext TEXT NOT NULL,
    iv VARCHAR(64) NOT NULL,
    tag VARCHAR(64) NOT NULL,
    masked_value VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broker_accounts (
    id SERIAL PRIMARY KEY,
    broker_connection_id INTEGER NOT NULL REFERENCES broker_connections(id) ON DELETE CASCADE,
    external_account_id VARCHAR(255),
    display_name VARCHAR(255),
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_instrument_settings (
    id SERIAL PRIMARY KEY,
    broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
    instrument_id INTEGER NOT NULL,
    symbol VARCHAR(50) NOT NULL,
    lot_size DECIMAL(18, 8) NOT NULL DEFAULT 0.01,
    enabled BOOLEAN NOT NULL DEFAULT true,
    trading_enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(broker_account_id, instrument_id)
);

CREATE TABLE IF NOT EXISTS market_state_snapshots (
    id BIGSERIAL PRIMARY KEY,
    instrument_id INTEGER NOT NULL,
    snapshot_data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evidence_reports (
    id BIGSERIAL PRIMARY KEY,
    setup_id BIGINT NOT NULL,
    report_data JSONB NOT NULL,
    evidence_strength DECIMAL(18, 8),
    is_valid BOOLEAN NOT NULL DEFAULT false,
    market_state_snapshot_id BIGINT REFERENCES market_state_snapshots(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trade_intents (
    id BIGSERIAL PRIMARY KEY,
    setup_id BIGINT NOT NULL,
    instrument_id INTEGER NOT NULL,
    direction VARCHAR(10) NOT NULL,
    decision VARCHAR(20) NOT NULL,
    reference_price DECIMAL(18, 8),
    expected_value_after_costs DECIMAL(18, 8),
    probability DECIMAL(8, 6),
    evidence_report_id BIGINT REFERENCES evidence_reports(id),
    market_state_snapshot_id BIGINT REFERENCES market_state_snapshots(id),
    explanation TEXT,
    reason_codes JSONB,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS executions (
    id BIGSERIAL PRIMARY KEY,
    trade_intent_id BIGINT NOT NULL REFERENCES trade_intents(id),
    broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id),
    success BOOLEAN NOT NULL DEFAULT false,
    fill_price DECIMAL(18, 8),
    quantity DECIMAL(18, 8),
    error_message TEXT,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS positions (
    id BIGSERIAL PRIMARY KEY,
    execution_id BIGINT REFERENCES executions(id),
    broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id),
    instrument_id INTEGER NOT NULL,
    direction VARCHAR(10) NOT NULL,
    entry_price DECIMAL(18, 8) NOT NULL,
    quantity DECIMAL(18, 8) NOT NULL,
    stop_loss DECIMAL(18, 8),
    take_profit DECIMAL(18, 8),
    mfe DECIMAL(18, 8) DEFAULT 0,
    mae DECIMAL(18, 8) DEFAULT 0,
    peak_retention DECIMAL(8, 6) DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trades (
    id BIGSERIAL PRIMARY KEY,
    position_id BIGINT NOT NULL REFERENCES positions(id),
    broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id),
    instrument_id INTEGER NOT NULL,
    direction VARCHAR(10) NOT NULL,
    entry_price DECIMAL(18, 8) NOT NULL,
    exit_price DECIMAL(18, 8),
    quantity DECIMAL(18, 8) NOT NULL,
    pnl DECIMAL(18, 8),
    exit_reason VARCHAR(50),
    setup_id BIGINT,
    regime VARCHAR(50),
    opened_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor VARCHAR(255) NOT NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id VARCHAR(100),
    previous_value JSONB,
    new_value JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_events (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_intents_instrument ON trade_intents(instrument_id);
CREATE INDEX IF NOT EXISTS idx_trade_intents_created ON trade_intents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_intent ON executions(trade_intent_id);
CREATE INDEX IF NOT EXISTS idx_positions_account ON positions(broker_account_id);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_trades_account ON trades(broker_account_id);
CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_events_created ON system_events(created_at DESC);
