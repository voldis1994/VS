-- VS CORE durable order / decision / incident / audit extensions
CREATE TABLE IF NOT EXISTS vs_orders (
    intent_id UUID PRIMARY KEY,
    client_order_id VARCHAR(128) NOT NULL UNIQUE,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL,
    epic VARCHAR(64) NOT NULL,
    direction VARCHAR(8) NOT NULL,
    size DECIMAL(18, 8) NOT NULL,
    state VARCHAR(32) NOT NULL,
    strategy_version VARCHAR(128) NOT NULL,
    config_version VARCHAR(64) NOT NULL,
    market_snapshot_id VARCHAR(128),
    decision_id UUID NOT NULL,
    broker_deal_reference VARCHAR(128),
    broker_deal_id VARCHAR(128),
    reject_reason TEXT,
    history JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vs_orders_client ON vs_orders(client_id);
CREATE INDEX IF NOT EXISTS idx_vs_orders_account_epic ON vs_orders(account_id, epic);

CREATE TABLE IF NOT EXISTS vs_decisions (
    decision_id UUID PRIMARY KEY,
    client_id INTEGER,
    epic VARCHAR(64) NOT NULL,
    code VARCHAR(64) NOT NULL,
    direction VARCHAR(8),
    strategy_version VARCHAR(128) NOT NULL,
    config_version VARCHAR(64) NOT NULL,
    market_snapshot_id VARCHAR(128),
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vs_incidents (
    id UUID PRIMARY KEY,
    severity VARCHAR(16) NOT NULL,
    client_id INTEGER,
    component VARCHAR(128) NOT NULL,
    error_code VARCHAR(64) NOT NULL,
    reason TEXT NOT NULL,
    technical_details TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    recovery_action TEXT,
    resolved BOOLEAN NOT NULL DEFAULT false,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vs_audit_events (
    id BIGSERIAL PRIMARY KEY,
    actor VARCHAR(128) NOT NULL,
    action VARCHAR(64) NOT NULL,
    client_id INTEGER,
    result VARCHAR(32) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vs_client_trading_state (
    client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    account_id INTEGER,
    strategy_profile VARCHAR(128) NOT NULL DEFAULT 'default',
    risk_profile VARCHAR(128) NOT NULL DEFAULT 'default',
    trading_enabled BOOLEAN NOT NULL DEFAULT false,
    stop_position_policy VARCHAR(32) NOT NULL DEFAULT 'LEAVE_OPEN',
    started_at TIMESTAMPTZ,
    stopped_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vs_software_versions (
    id SERIAL PRIMARY KEY,
    core_version VARCHAR(64) NOT NULL,
    strategy_version VARCHAR(128) NOT NULL,
    config_version VARCHAR(64) NOT NULL,
    db_schema_version VARCHAR(32) NOT NULL,
    git_commit VARCHAR(64),
    activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
