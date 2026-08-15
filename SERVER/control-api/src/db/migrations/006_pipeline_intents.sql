-- Pipeline intent fan-out support for Client Panel subscriptions
ALTER TABLE trade_intents
  ADD COLUMN IF NOT EXISTS epic VARCHAR(120),
  ADD COLUMN IF NOT EXISTS setup_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_trade_intents_status_pending
  ON trade_intents(status, created_at ASC)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_trade_intents_epic ON trade_intents(epic);
