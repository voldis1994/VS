-- VS MASTER manage_config singleton — DualPersist primary survives file wipe
-- so operator manage/exit/risk knobs heal without post-wipe re-seed.
CREATE TABLE IF NOT EXISTS master_manage_config (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
