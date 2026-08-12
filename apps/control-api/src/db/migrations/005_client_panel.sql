-- Client Control Panel: access credentials + panel runtime prefs + sessions

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS access_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS access_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS preferred_broker_account_id INTEGER REFERENCES broker_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS panel_epic VARCHAR(120),
  ADD COLUMN IF NOT EXISTS panel_display_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS panel_lot_size DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS panel_robot_requested VARCHAR(20) NOT NULL DEFAULT 'STOPPED',
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS client_sessions (
  id BIGSERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_sessions_client ON client_sessions(client_id);
CREATE INDEX IF NOT EXISTS idx_client_sessions_expires ON client_sessions(expires_at);

CREATE TABLE IF NOT EXISTS client_login_attempts (
  id BIGSERIAL PRIMARY KEY,
  ip VARCHAR(64) NOT NULL,
  success BOOLEAN NOT NULL DEFAULT false,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_login_attempts_ip_time
  ON client_login_attempts(ip, attempted_at DESC);
