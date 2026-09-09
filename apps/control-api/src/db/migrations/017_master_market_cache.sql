-- VS MASTER market_cache singleton — DualPersist primary survives file wipe
-- so desk hour_bars / closed_10s / bars / quote heal without network refill.
CREATE TABLE IF NOT EXISTS master_market_cache (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
