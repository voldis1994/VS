-- VS MASTER news_calendar singleton — DualPersist primary survives file wipe
-- so Forex Factory high-impact gate does not fail-open after restart before fetch.
CREATE TABLE IF NOT EXISTS master_news_calendar (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
