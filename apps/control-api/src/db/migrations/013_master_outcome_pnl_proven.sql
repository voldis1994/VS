-- Capital LIVE: durable fail-close flag for unproven realized PnL
-- (null/true = proven or legacy; false = do not update day gates / expectancy)
ALTER TABLE master_trade_outcomes
  ADD COLUMN IF NOT EXISTS pnl_proven BOOLEAN;
