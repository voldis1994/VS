-- VS MASTER news_window singleton — DualPersist primary survives file wipe
-- so high-impact news hard-gate does not fail-open after Phase K wipe.
CREATE TABLE IF NOT EXISTS master_news_window (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
