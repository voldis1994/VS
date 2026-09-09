-- VS MASTER error_journal singleton — DualPersist primary survives file wipe
-- so dashboard Last error / recent_errors stay honest after Phase K wipe.
CREATE TABLE IF NOT EXISTS master_error_journal (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
