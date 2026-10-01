-- Persist admin robot-desk desired state across control-api / PC restarts.
CREATE TABLE IF NOT EXISTS robot_desk_persist (
  id VARCHAR(160) PRIMARY KEY,
  account_id INTEGER NOT NULL,
  epic VARCHAR(128) NOT NULL,
  display_name VARCHAR(255),
  lot_size DECIMAL(18, 8) NOT NULL DEFAULT 0.1,
  trading_enabled BOOLEAN NOT NULL DEFAULT true,
  entry_enabled BOOLEAN NOT NULL DEFAULT true,
  desired_running BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_robot_desk_persist_running
  ON robot_desk_persist (desired_running)
  WHERE desired_running = true;
