-- Store broker position_id on trade outcomes (not just opportunity_id)
ALTER TABLE master_trade_outcomes
  ADD COLUMN IF NOT EXISTS position_id TEXT;
