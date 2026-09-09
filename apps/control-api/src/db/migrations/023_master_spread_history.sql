-- VS MASTER spread_history singleton — DualPersist primary survives file wipe
-- so relative-spread gate does not cold-open after Phase K wipe.
CREATE TABLE IF NOT EXISTS master_spread_history (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
