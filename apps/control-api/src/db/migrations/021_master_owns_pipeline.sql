-- VS MASTER owns_pipeline singleton — DualPersist primary survives file wipe
-- so MASTER owns Client fanout preference heals without post-wipe re-seed.
CREATE TABLE IF NOT EXISTS master_owns_pipeline (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
