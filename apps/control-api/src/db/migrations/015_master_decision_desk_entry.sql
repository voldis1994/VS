-- Desk 10s confirm provenance on decision audit (survive DualPersist hydrate)
ALTER TABLE master_decision_events
  ADD COLUMN IF NOT EXISTS desk_entry_source TEXT,
  ADD COLUMN IF NOT EXISTS desk_entry_side TEXT,
  ADD COLUMN IF NOT EXISTS hour_bias TEXT,
  ADD COLUMN IF NOT EXISTS closed_10s_present BOOLEAN;
