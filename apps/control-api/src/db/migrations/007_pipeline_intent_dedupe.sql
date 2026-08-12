-- Idempotency for pipeline intent fan-out (retry-safe)
CREATE TABLE IF NOT EXISTS pipeline_intent_dedupe (
  idempotency_key VARCHAR(190) PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fanout_summary JSONB
);

CREATE INDEX IF NOT EXISTS idx_pipeline_intent_dedupe_created
  ON pipeline_intent_dedupe(created_at DESC);
