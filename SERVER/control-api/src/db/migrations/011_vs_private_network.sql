-- VS Private Network — production authority schema (mirrors durable file registry)
-- Private keys are NEVER stored in this database.

CREATE TABLE IF NOT EXISTS vs_network_meta (
    server_id VARCHAR(64) PRIMARY KEY,
    server_public_key TEXT,
    server_private_ip VARCHAR(64) NOT NULL DEFAULT '10.77.0.1',
    server_endpoint_hostname VARCHAR(255),
    wg_listen_port INTEGER NOT NULL DEFAULT 51820,
    wg_interface VARCHAR(32) NOT NULL DEFAULT 'vs0',
    next_admin_ip INTEGER NOT NULL DEFAULT 1,
    next_client_ip INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vs_network_devices (
    device_id VARCHAR(64) PRIMARY KEY,
    device_name VARCHAR(128) NOT NULL,
    device_type VARCHAR(16) NOT NULL,
    public_key TEXT NOT NULL UNIQUE,
    key_fingerprint VARCHAR(64) NOT NULL,
    private_address VARCHAR(64) NOT NULL UNIQUE,
    client_id INTEGER,
    account_id INTEGER,
    owner_scope VARCHAR(128),
    role VARCHAR(32) NOT NULL,
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at TIMESTAMPTZ,
    last_seen TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    key_version INTEGER NOT NULL DEFAULT 1,
    connection_state VARCHAR(32) NOT NULL DEFAULT 'DISCONNECTED',
    session_id UUID,
    connected_at TIMESTAMPTZ,
    latency_ms INTEGER,
    device_token_hash VARCHAR(128),
    CONSTRAINT vs_network_devices_type_chk CHECK (device_type IN ('SERVER', 'ADMIN', 'CLIENT')),
    CONSTRAINT vs_network_devices_status_chk CHECK (status IN ('NEW', 'PENDING_APPROVAL', 'ACTIVE', 'REVOKED')),
    CONSTRAINT vs_network_devices_conn_chk CHECK (connection_state IN ('CONNECTED', 'STALE', 'DISCONNECTED', 'REVOKED'))
);

CREATE INDEX IF NOT EXISTS idx_vs_network_devices_status ON vs_network_devices(status);
CREATE INDEX IF NOT EXISTS idx_vs_network_devices_client ON vs_network_devices(client_id);

CREATE TABLE IF NOT EXISTS vs_network_enrollments (
    enrollment_id VARCHAR(64) PRIMARY KEY,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    device_type VARCHAR(16) NOT NULL,
    device_id VARCHAR(64),
    client_id INTEGER,
    account_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_by VARCHAR(128) NOT NULL
);

CREATE TABLE IF NOT EXISTS vs_network_command_dedupe (
    command_id VARCHAR(128) PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vs_network_audit (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action VARCHAR(64) NOT NULL,
    actor VARCHAR(128) NOT NULL,
    device_id VARCHAR(64),
    result VARCHAR(32) NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_vs_network_audit_at ON vs_network_audit(at DESC);
