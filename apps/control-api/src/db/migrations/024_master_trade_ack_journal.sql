-- VS MASTER trade_ack_journal singleton — DualPersist primary survives file wipe
-- so INTENT→ACK crash recovery (adopt OPEN SUCCESS) does not lose rows after Phase K wipe.
CREATE TABLE IF NOT EXISTS master_trade_ack_journal (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  saved_at_ms BIGINT NOT NULL
);
