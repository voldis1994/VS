-- Default: instruments are tradeable (operator accepts risk; no soft OFF gate)
UPDATE account_instrument_settings
SET enabled = true,
    trading_enabled = true,
    updated_at = NOW()
WHERE enabled = false OR trading_enabled = false;
