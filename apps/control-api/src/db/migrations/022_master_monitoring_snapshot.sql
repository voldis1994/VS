-- VS MASTER monitoring_snapshot singleton — DualPersist primary survives file wipe
-- so Why / Alert block / Rel spread hydrate honesty without post-wipe re-seed.
CREATE TABLE IF NOT EXISTS master_monitoring_snapshot (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
