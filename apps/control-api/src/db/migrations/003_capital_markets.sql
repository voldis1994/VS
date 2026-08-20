CREATE TABLE IF NOT EXISTS capital_markets (
    id SERIAL PRIMARY KEY,
    broker_connection_id INTEGER NOT NULL REFERENCES broker_connections(id) ON DELETE CASCADE,
    epic VARCHAR(120) NOT NULL,
    symbol VARCHAR(120) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    instrument_type VARCHAR(100),
    category VARCHAR(100) NOT NULL DEFAULT 'other',
    min_lot DECIMAL(18, 8) NOT NULL DEFAULT 0.01,
    max_lot DECIMAL(18, 8) NOT NULL DEFAULT 100,
    lot_step DECIMAL(18, 8) NOT NULL DEFAULT 0.01,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (broker_connection_id, epic)
);

CREATE INDEX IF NOT EXISTS idx_capital_markets_connection ON capital_markets(broker_connection_id);
CREATE INDEX IF NOT EXISTS idx_capital_markets_category ON capital_markets(category);
CREATE INDEX IF NOT EXISTS idx_capital_markets_name ON capital_markets(display_name);
