-- VS MASTER epic_cycle_stash singleton — DualPersist primary survives file wipe
-- so GOLD↔SILVER SETUP/cycle Maps heal without re-seeding after Phase K wipe.
CREATE TABLE IF NOT EXISTS master_epic_cycle_stash (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
