# Security

## Credential encryption

Control-api encrypts broker secrets with **AES-256-GCM** (`apps/control-api/src/security/encryption.ts`):

- Key derived via `scryptSync(MASTER_ENCRYPTION_KEY, 'market-reader-salt', 32)`  
- Random 16-byte IV per encryption  
- Auth tag stored with ciphertext  
- DB columns: `ciphertext`, `iv`, `tag`, plus `masked_value` for UI  

On `POST /api/brokers`, `api_key` and `password` are encrypted before insert into `api_credential_metadata`. Listing brokers returns masked values only (`••••••••••` + last 4).

## Environment secrets

`.env` (from `.env.example`) holds:

| Variable | Purpose |
|----------|---------|
| `MASTER_ENCRYPTION_KEY` | Envelope key material |
| `API_ADMIN_TOKEN` | Admin API auth |
| `JWT_SECRET` | Reserved for auth expansion |
| `DB_PASSWORD` | Postgres |
| `CAPITAL_API_*` | Optional process-level Capital.com vars |

`.env` is gitignored. Security tests assert `.env.example` uses `CHANGE_ME` placeholders and no live key patterns.

## API authentication

`authMiddleware` requires header `x-admin-token` matching `API_ADMIN_TOKEN` for non-public routes.

Public without token:

- `GET /health`  
- `GET /api/system/status`  
- `GET /api/system/mode`  

If the token is unset or still `CHANGE_ME_ADMIN_TOKEN`:

- Development: requests allowed  
- Production (`NODE_ENV=production`): 401  

## Operational controls

- LIVE trading disabled unless `LIVE_TRADING_ENABLED=true` (market-core refuses LIVE otherwise).  
- Mode changes via API still enforce the live gate.  
- Audit log records client/broker/instrument mutations (`audit_logs`).  
- Secrets must not appear in dashboard bundles, git, or plaintext DB columns.

## Testing

- C++: `tests/security/test_security.cpp` — env placeholders / gitignore  
- Node: `apps/control-api/src/security/encryption.test.ts` — encrypt/decrypt/mask round-trips (`npm test` in control-api)
