-- Per client/account execution claims — concurrent-safe idempotency
-- One EntryReady (idempotency_key) may fan out to many clients; each account executes once.
CREATE TABLE IF NOT EXISTS pipeline_execution_claims (
  idempotency_key VARCHAR(190) NOT NULL,
  client_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'claimed',
  result_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (idempotency_key, client_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_execution_claims_created
  ON pipeline_execution_claims(created_at DESC);
