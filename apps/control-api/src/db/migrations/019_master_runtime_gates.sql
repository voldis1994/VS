-- VS MASTER runtime_gates singleton — DualPersist primary survives file wipe
-- so kill_switch / desired_running / day equity / mode / epic heal without re-seed.
CREATE TABLE IF NOT EXISTS master_runtime_gates (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
