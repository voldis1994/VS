# Security

- ADMIN token ≠ CLIENT token  
- CLIENT API rejects `x-admin-token` (403)  
- Secrets only on i3 (`/var/lib/vs-server/server.env`)  
- Never commit Capital/WG private keys  
- Audit redacts token/password fields  
- Firewall: Postgres/Redis not for WG clients (`DEPLOY/firewall`, `DOCS/PORTS.md`)
