-- 015_per_account_capital_epic.sql
-- Capital market pull is catalog-only. Operators must explicitly assign one
-- EPIC per account. No account gets trading_enabled=true automatically.
--
-- Safety step: clear any previously auto-enabled rows so no account
-- accidentally starts trading a market that was never intentionally chosen.
UPDATE account_instrument_settings SET trading_enabled = false WHERE trading_enabled = true;

-- DB-level invariant: at most ONE trading-enabled row per broker_account.
-- The SELECT endpoint that assigns a market enforces this in a transaction,
-- but this index is the hard backstop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ais_one_trading_enabled_per_account
    ON account_instrument_settings (broker_account_id)
    WHERE trading_enabled = true;

INSERT INTO schema_versions (schema_name, version)
VALUES ('vs', '015_per_account_capital_epic')
ON CONFLICT (schema_name, version) DO NOTHING;
