-- HTF Market Thesis outcome fields for learning / conditional EV.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS htf_thesis JSONB,
  ADD COLUMN IF NOT EXISTS htf_score DECIMAL(8, 6),
  ADD COLUMN IF NOT EXISTS thesis_direction_correct BOOLEAN,
  ADD COLUMN IF NOT EXISTS thesis_time_to_confirm_ms BIGINT,
  ADD COLUMN IF NOT EXISTS thesis_time_to_invalid_ms BIGINT,
  ADD COLUMN IF NOT EXISTS thesis_events_hit JSONB;

CREATE INDEX IF NOT EXISTS idx_trades_thesis_dir ON trades(thesis_direction_correct);
CREATE INDEX IF NOT EXISTS idx_trades_htf_score ON trades(htf_score);
