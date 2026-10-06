-- HTF Market State persistence on closed trades (conditional EV / expectancy).
-- JSONB snapshot frozen at entry; path_status updated at close when known.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS htf_state JSONB,
  ADD COLUMN IF NOT EXISTS htf_bias VARCHAR(16),
  ADD COLUMN IF NOT EXISTS htf_structure VARCHAR(16),
  ADD COLUMN IF NOT EXISTS htf_phase VARCHAR(24),
  ADD COLUMN IF NOT EXISTS htf_path_status VARCHAR(24);

CREATE INDEX IF NOT EXISTS idx_trades_htf_structure ON trades(htf_structure);
CREATE INDEX IF NOT EXISTS idx_trades_htf_phase ON trades(htf_phase);
CREATE INDEX IF NOT EXISTS idx_trades_htf_bias ON trades(htf_bias);
CREATE INDEX IF NOT EXISTS idx_trades_htf_combo
  ON trades(htf_structure, htf_phase, setup_type, direction);
