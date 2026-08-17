# Final startup audit

## MSI

```
START_MSI.bat
  → git pull (optional)
  → ADMIN/config/SERVER_IP.txt  (required IPv4)
  → ADMIN/windows/start-admin.ps1
       → GET http://<IP>:3000/health  (must be VS-CORE + VS-CORE-01)
       → GET /api/v1/admin/lan-bootstrap (token)
       → write runtime-config.js
       → if :5188 already VS ADMIN → reuse
       → if :5188 foreign process → FAIL (no kill)
       → npm run build if dist missing
       → node ADMIN/runtime/serve-admin.mjs  (127.0.0.1:5188)
  → browser http://127.0.0.1:5188/
  → UI polls i3 :3000 + posts heartbeat
```

No Vite dev. No `CONNECT_FORCE.bat` on the production path.

## i3

```
START_I3
  → git pull
  → SERVER/MAKE_IT_WORK.sh
       → rsync control-api, core, client-gateway
       → Postgres/Redis (keep existing DB unless VS_NUCLEAR_DB=1)
       → build CLIENT/desktop → /opt/vs-server/client-panel
       → APPLY_FIREWALL
       → systemd vs-server (:3000)
       → systemd vs-client-gateway (:443)
  → LAN /health check
```

Monitor: `vs-monitor` (does not stop the core).

## CLIENT

```
https://<host from /etc/vs/client-url>/
  → vs-client-gateway :443
  → allow only /api/client* /api/client-auth* /ws/client /health /static
  → Control API
  → session cookie / bearer
  → START/STOP → VS CORE robots
```

No hidden alternate start scripts in the production tree.
