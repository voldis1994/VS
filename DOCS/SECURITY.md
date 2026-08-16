# Security

- ADMIN token ≠ CLIENT token  
- CLIENT API rejects `x-admin-token` (403)  
- Secrets not in git / frontend bundles  
- Audit redacts token/password/secret keys (`SERVER/core/audit`)  
- Firewall: see `SERVER/network/APPLY_FIREWALL` and `DOCS/PORTS.md`  
- Rate limits / validation enforced in control-api security tests  
