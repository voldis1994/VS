-- VS MASTER journal / opportunity audit (signal → decision → risk → outcome)
CREATE TABLE IF NOT EXISTS master_opportunities (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mode TEXT NOT NULL,
  epic TEXT NOT NULL,
  decision_kind TEXT NOT NULL,
  side TEXT,
  score DOUBLE PRECISION,
  block_reason TEXT,
  regime TEXT,
  buy_score DOUBLE PRECISION,
  sell_score DOUBLE PRECISION,
  risk_allowed BOOLEAN,
  risk_volume DOUBLE PRECISION,
  risk_reasons TEXT,
  executed BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS master_trade_outcomes (
  id UUID PRIMARY KEY,
  opportunity_id UUID REFERENCES master_opportunities(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  side TEXT NOT NULL,
  entry_price DOUBLE PRECISION NOT NULL,
  exit_price DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL,
  pnl DOUBLE PRECISION NOT NULL,
  fees DOUBLE PRECISION NOT NULL DEFAULT 0,
  slippage DOUBLE PRECISION NOT NULL DEFAULT 0,
  mae DOUBLE PRECISION NOT NULL DEFAULT 0,
  mfe DOUBLE PRECISION NOT NULL DEFAULT 0,
  r_multiple DOUBLE PRECISION NOT NULL DEFAULT 0,
  hold_ms BIGINT NOT NULL DEFAULT 0,
  exit_reason TEXT,
  setup_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_master_opps_created ON master_opportunities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_master_outcomes_setup ON master_trade_outcomes(setup_key);

-- Restart recovery: open MASTER-managed positions + intent idempotency
CREATE TABLE IF NOT EXISTS master_open_positions (
  position_id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  epic TEXT NOT NULL,
  side TEXT NOT NULL,
  size DOUBLE PRECISION NOT NULL,
  entry DOUBLE PRECISION NOT NULL,
  entry_at TIMESTAMPTZ NOT NULL,
  stop_loss DOUBLE PRECISION,
  take_profit DOUBLE PRECISION,
  mfe DOUBLE PRECISION NOT NULL DEFAULT 0,
  mae DOUBLE PRECISION NOT NULL DEFAULT 0,
  regime_at_entry TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS master_seen_intents (
  intent_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
