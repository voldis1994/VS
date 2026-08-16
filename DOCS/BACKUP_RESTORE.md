# Backup / restore

```bash
sudo bash SERVER/install/BACKUP_SERVER.sh
sudo bash SERVER/LIST_BACKUPS.sh
sudo bash SERVER/VERIFY_BACKUP.sh /var/lib/vs-server/backup/vs-pg-….sql.gz
sudo bash SERVER/install/RESTORE_SERVER.sh <file.sql.gz> CONFIRM
```

Postgres dump + metadata JSON. Do not export private secrets in ordinary backups without a documented secure mechanism.
