-- Desk confirm provenance on trade audit (OPEN/CLOSE survive DualPersist hydrate)
ALTER TABLE master_trade_events
  ADD COLUMN IF NOT EXISTS desk_entry_source TEXT;
