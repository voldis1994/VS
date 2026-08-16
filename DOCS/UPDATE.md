# Update

```bash
sudo bash SERVER/install/UPDATE_SERVER.sh /path/to/staged-VS-SERVER
```

Sequence: backup → kill-switch/trading off → stop → deploy (operator-gated) → migrate → restart → healthcheck.

Failure: mark FAILED, preserve logs, restore from backup. Never claim success on failed healthcheck.
