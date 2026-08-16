# Database

**Engine:** PostgreSQL on VS-CORE-01 only.  
**Runner:** `SERVER/control-api` → `SERVER/database/migrations` (symlink).

## Migrations

001–013 including:

- clients, accounts, positions, orders (canonical + vs_*)
- kill_switch, regime_history, signals, risk_decisions
- reconciliation_*, backup_*, update_history
- wireguard_peers, devices, admin_users/roles
- market_feed_status, candles, audit_events, incidents

Fresh empty DB becomes operational via migrate command alone.

**Redis:** ephemeral cache/pubsub/locks — not sole authority for orders/positions.
