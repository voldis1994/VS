# Server install (i3 / Debian)

```bash
cd /root/VS   # or ~/VS-new
git pull origin main
sudo bash SERVER/install/INSTALL_SERVER.sh
# equivalent: sudo bash SERVER/INSTALL_I3_SERVER
```

Ops:

```bash
sudo bash SERVER/START_SERVER
sudo bash SERVER/STOP_SERVER
sudo bash SERVER/RESTART_SERVER
sudo bash SERVER/STATUS_SERVER
sudo bash SERVER/install/HEALTHCHECK.sh
sudo bash SERVER/dashboard/SHOW_DASHBOARD.sh   # or START_MONITOR
sudo bash SERVER/INSTALL_MONITOR              # if unit missing
```

LIVE trading remains **disabled** after install.
