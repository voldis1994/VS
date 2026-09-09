-- VS MASTER Reader-style audit journals (cycle decisions + OPEN/MODIFY/CLOSE)
-- PG primary under DualPersist; JSONL + master_state remain hot/mirror paths.
CREATE TABLE IF NOT EXISTS master_decision_events (
  event_id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL,
  epic TEXT NOT NULL,
  mode TEXT NOT NULL,
  opportunity_id TEXT,
  buy_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  sell_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  block_reason TEXT,
  executed BOOLEAN NOT NULL DEFAULT FALSE,
  execution_detail TEXT,
  cycle_ms BIGINT
);

CREATE INDEX IF NOT EXISTS idx_master_decision_events_ts
  ON master_decision_events (ts DESC);

CREATE TABLE IF NOT EXISTS master_trade_events (
  event_id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  event TEXT NOT NULL,
  broker TEXT NOT NULL,
  epic TEXT NOT NULL DEFAULT '',
  side TEXT,
  volume DOUBLE PRECISION,
  price DOUBLE PRECISION,
  position_id TEXT,
  intent_id TEXT,
  opportunity_id TEXT,
  ok BOOLEAN NOT NULL DEFAULT FALSE,
  detail TEXT,
  pnl DOUBLE PRECISION,
  fees DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_master_trade_events_ts
  ON master_trade_events (ts DESC);
