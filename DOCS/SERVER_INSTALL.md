# Server install (i3 / Debian 13)

```bash
cd /root/VS
sudo bash SERVER/install/INSTALL_SERVER.sh
sudo bash SERVER/install/HEALTHCHECK.sh
sudo bash SERVER/FINAL_ACCEPTANCE.sh
sudo bash SERVER/SHOW_DASHBOARD.sh   # optional monitor
```

Idempotent. Does not destroy DB/secrets on re-run.

Normal reboot: systemd starts `vs-server` — no terminal login required.

Configure `/var/lib/vs-server/server.env`:

- `API_ADMIN_TOKEN`
- Capital credentials (optional until trading)
- `PUBLIC_HOST_OR_IP` / `WIREGUARD_PORT` for remote clients
- `LIVE_TRADING_ENABLED=false` (default)

Backup/restore: `SERVER/install/BACKUP_SERVER.sh`, `RESTORE_SERVER.sh` (requires `CONFIRM`).
