-- VS MASTER client_fanout singleton — DualPersist primary survives file wipe
-- so Client fanout dashboard card does not cold-blank after Phase K wipe.
CREATE TABLE IF NOT EXISTS master_client_fanout (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
