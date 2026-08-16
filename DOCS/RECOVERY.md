# Recovery

| Failure | Action |
|---------|--------|
| DB loss | `RESTORE_SERVER.sh <backup> CONFIRM` |
| Bad update | Rollback package + restore backup |
| Lost ADMIN token | Regenerate on i3 `server.env`, re-enroll MSI |
| Lost CLIENT device | ADMIN revoke + re-enroll |
| Broker down | TRADING_READY=false; no fake CONNECTED |
| MSI offline | Server continues |
| CLIENT offline | Server continues |
