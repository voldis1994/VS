# Troubleshooting

| Symptom | Check |
|---------|-------|
| ADMIN SERVER OFFLINE | `curl http://192.168.0.10:3000/health`; token; firewall |
| CLIENT NOT READY | `wg show`; ping `10.77.0.1`; `PUBLIC_HOST_OR_IP`; UDP 51820 forward |
| BROKER CONFIG_REQUIRED | Capital env on i3 only |
| TRADING_READY false | Expected until broker+reconcile+LIVE flag |
| EACCES node_modules | Re-run installer as documented user; fix ownership under `/opt/vs` |
| Postgres ECONNREFUSED | `docker ps`; `HEALTHCHECK.sh` |

Closing i3 monitor or MSI ADMIN must **not** stop `vs-server`.
