-- Closed-trade ledger: attribution fields for expectancy / edge measurement.
-- position_id becomes nullable — desk closes may not always have a clean FK.

ALTER TABLE trades
  ALTER COLUMN position_id DROP NOT NULL;

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS epic VARCHAR(100),
  ADD COLUMN IF NOT EXISTS setup_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS mfe DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS mae DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS peak_retention DECIMAL(8, 6),
  ADD COLUMN IF NOT EXISTS hold_ms BIGINT,
  ADD COLUMN IF NOT EXISTS pnl_pts DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS exit_mid DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS source VARCHAR(30),
  ADD COLUMN IF NOT EXISTS robot_id VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_trades_regime ON trades(regime);
CREATE INDEX IF NOT EXISTS idx_trades_epic ON trades(epic);
CREATE INDEX IF NOT EXISTS idx_trades_setup ON trades(setup_type);
CREATE INDEX IF NOT EXISTS idx_trades_source ON trades(source);
