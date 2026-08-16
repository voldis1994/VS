-- 013_canonical_entities.sql
-- Remaining durable entities required by production master task.
-- Idempotent. Does not drop or rewrite existing operational tables.

CREATE TABLE IF NOT EXISTS admin_users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(128) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'ADMIN',
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT admin_users_role_chk CHECK (role IN ('OWNER_ADMIN','ADMIN','OPERATOR'))
);

CREATE TABLE IF NOT EXISTS admin_sessions (
    id UUID PRIMARY KEY,
    admin_user_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(admin_user_id);

CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(128) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

INSERT INTO roles (name) VALUES
  ('OWNER_ADMIN'), ('ADMIN'), ('OPERATOR'), ('CLIENT')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS client_profiles (
    client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    display_name VARCHAR(255),
    timezone VARCHAR(64),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_status (
    client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL DEFAULT 'DISABLED',
    reason TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT client_status_chk CHECK (
      status IN ('ACTIVE','PAUSED','DISABLED','REVOKED')
    )
);

CREATE TABLE IF NOT EXISTS devices (
    id BIGSERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    device_label VARCHAR(128) NOT NULL,
    public_key TEXT,
    vpn_ip INET,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    CONSTRAINT devices_status_chk CHECK (
      status IN ('PENDING','ACTIVE','DISABLED','REVOKED')
    )
);
CREATE INDEX IF NOT EXISTS idx_devices_client ON devices(client_id);

CREATE TABLE IF NOT EXISTS device_sessions (
    id UUID PRIMARY KEY,
    device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_tokens (
    id BIGSERIAL PRIMARY KEY,
    device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    purpose VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounts (
    id BIGSERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    broker_account_ref VARCHAR(128),
    currency VARCHAR(16) NOT NULL DEFAULT 'USD',
    enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, broker_account_ref)
);

CREATE TABLE IF NOT EXISTS account_balances (
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    balance NUMERIC(18,8),
    available NUMERIC(18,8),
    equity NUMERIC(18,8),
    as_of TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_balances_acct ON account_balances(account_id, as_of DESC);

CREATE TABLE IF NOT EXISTS account_permissions (
    account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    permission VARCHAR(64) NOT NULL,
    PRIMARY KEY (account_id, permission)
);

CREATE TABLE IF NOT EXISTS instruments (
    symbol VARCHAR(64) PRIMARY KEY,
    epic VARCHAR(128),
    name VARCHAR(255),
    asset_class VARCHAR(64),
    enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instrument_config (
    symbol VARCHAR(64) PRIMARY KEY REFERENCES instruments(symbol) ON DELETE CASCADE,
    max_spread NUMERIC(18,8),
    min_stop_distance NUMERIC(18,8),
    max_size NUMERIC(18,8),
    tick_size NUMERIC(18,8),
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_sources (
    id SERIAL PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    role VARCHAR(32) NOT NULL DEFAULT 'PRIMARY',
    enabled BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT market_sources_role_chk CHECK (role IN ('PRIMARY','REFERENCE'))
);

CREATE TABLE IF NOT EXISTS candles (
    id BIGSERIAL PRIMARY KEY,
    symbol VARCHAR(64) NOT NULL,
    timeframe VARCHAR(8) NOT NULL,
    open_time TIMESTAMPTZ NOT NULL,
    open NUMERIC(18,8) NOT NULL,
    high NUMERIC(18,8) NOT NULL,
    low NUMERIC(18,8) NOT NULL,
    close NUMERIC(18,8) NOT NULL,
    volume NUMERIC(18,8),
    UNIQUE (symbol, timeframe, open_time),
    CONSTRAINT candles_tf_chk CHECK (timeframe IN ('M1','M5','M15','M30','H1','H4','D1'))
);
CREATE INDEX IF NOT EXISTS idx_candles_symbol_tf_time ON candles(symbol, timeframe, open_time DESC);

CREATE TABLE IF NOT EXISTS strategy_decisions (
    id BIGSERIAL PRIMARY KEY,
    strategy VARCHAR(128) NOT NULL,
    strategy_version VARCHAR(64) NOT NULL DEFAULT '1',
    symbol VARCHAR(64) NOT NULL,
    regime VARCHAR(64) NOT NULL,
    result VARCHAR(16) NOT NULL,
    reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    signal_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT strategy_decisions_result_chk CHECK (result IN ('SIGNAL','NO_TRADE'))
);

CREATE TABLE IF NOT EXISTS risk_profiles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(128) NOT NULL UNIQUE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risk_limits (
    id SERIAL PRIMARY KEY,
    profile_id INTEGER REFERENCES risk_profiles(id) ON DELETE CASCADE,
    account_id BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
    max_spread NUMERIC(18,8),
    max_size NUMERIC(18,8),
    max_exposure NUMERIC(18,8),
    config JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY,
    account_id BIGINT REFERENCES accounts(id),
    client_id INTEGER REFERENCES clients(id),
    symbol VARCHAR(64) NOT NULL,
    direction VARCHAR(8) NOT NULL,
    size NUMERIC(18,8) NOT NULL,
    state VARCHAR(32) NOT NULL,
    broker_order_id VARCHAR(128),
    client_order_id VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT orders_direction_chk CHECK (direction IN ('BUY','SELL','LONG','SHORT')),
    CONSTRAINT orders_state_chk CHECK (state IN (
      'CREATED','VALIDATING','RISK_APPROVED','RISK_REJECTED','SUBMITTING','SUBMITTED',
      'ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCEL_PENDING','CANCELLED','REJECTED',
      'EXPIRED','UNKNOWN','RECONCILIATION_REQUIRED'
    ))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_order_id ON orders(client_order_id) WHERE client_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_events (
    id BIGSERIAL PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    from_state VARCHAR(32),
    to_state VARCHAR(32) NOT NULL,
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fills (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    size NUMERIC(18,8) NOT NULL,
    price NUMERIC(18,8) NOT NULL,
    broker_fill_id VARCHAR(128),
    filled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS position_events (
    id BIGSERIAL PRIMARY KEY,
    position_id BIGINT,
    event_type VARCHAR(64) NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broker_sessions (
    id BIGSERIAL PRIMARY KEY,
    environment VARCHAR(16) NOT NULL,
    state VARCHAR(32) NOT NULL,
    detail TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    CONSTRAINT broker_sessions_state_chk CHECK (
      state IN ('CONFIG_REQUIRED','CONNECTING','CONNECTED','DISCONNECTED','ERROR')
    )
);

CREATE TABLE IF NOT EXISTS broker_snapshots (
    id BIGSERIAL PRIMARY KEY,
    session_id BIGINT REFERENCES broker_sessions(id) ON DELETE SET NULL,
    kind VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incidents (
    id BIGSERIAL PRIMARY KEY,
    severity VARCHAR(16) NOT NULL,
    code VARCHAR(64) NOT NULL,
    message TEXT NOT NULL,
    open BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    CONSTRAINT incidents_sev_chk CHECK (severity IN ('INFO','WARN','ERROR','CRITICAL'))
);

CREATE TABLE IF NOT EXISTS incident_events (
    id BIGSERIAL PRIMARY KEY,
    incident_id BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
    id BIGSERIAL PRIMARY KEY,
    actor VARCHAR(128) NOT NULL,
    action VARCHAR(128) NOT NULL,
    resource VARCHAR(128),
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_time ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS wireguard_peers (
    id BIGSERIAL PRIMARY KEY,
    device_id BIGINT REFERENCES devices(id) ON DELETE SET NULL,
    public_key TEXT NOT NULL UNIQUE,
    vpn_ip INET NOT NULL UNIQUE,
    endpoint TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

INSERT INTO schema_versions (schema_name, version)
VALUES ('vs', '013_canonical_entities')
ON CONFLICT (schema_name, version) DO NOTHING;
