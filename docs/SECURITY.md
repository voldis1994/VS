# Security

## Credential encryption

Control-api encrypts broker secrets with **AES-256-GCM** (`apps/control-api/src/security/encryption.ts`):

- Key derived via `scryptSync(MASTER_ENCRYPTION_KEY, 'market-reader-salt', 32)`  
- Random 16-byte IV per encryption  
- Auth tag stored with ciphertext  
- DB columns: `ciphertext`, `iv`, `tag`, plus `masked_value` for UI  
- **Placeholder keys are refused** — `encrypt`/`decrypt` throw if `MASTER_ENCRYPTION_KEY` is missing or still `CHANGE_ME*`

On `POST /api/brokers`, `api_key` and `password` are encrypted before insert into `api_credential_metadata`. Listing brokers returns masked values only (`••••••••••` + last 4).

## Environment secrets

`.env` (from `.env.example`) holds:

| Variable | Purpose |
|----------|---------|
| `MASTER_ENCRYPTION_KEY` | Envelope key material (required) |
| `API_ADMIN_TOKEN` | Admin API auth (required) |
| `PIPELINE_TOKEN` | Market-core → control-api bridge auth |
| `JWT_SECRET` | Reserved for auth expansion |
| `DB_PASSWORD` | Postgres |
| `CAPITAL_API_*` | Optional process-level Capital.com vars |

`.env` is gitignored. `VS.bat` replaces `CHANGE_ME*` secrets with unique random values on first run and writes `apps/dashboard/.env.local` (`VITE_ADMIN_TOKEN`) so the admin desk sends `x-admin-token`.

Escape hatch for local DX only: `ALLOW_INSECURE_DEV=true` (ignored when `NODE_ENV=production`).

## API authentication

`authMiddleware` requires header `x-admin-token` matching `API_ADMIN_TOKEN` for non-public routes (timing-safe compare).

Public without token:

- `GET /health`  
- `GET /api/system/status`  
- `GET /api/system/mode` (read only — **POST requires admin**)  
- `/api/client-auth/*`, `/api/client/*`, `/ws/client`  

If the token is unset or still `CHANGE_ME*`: **401** unless `ALLOW_INSECURE_DEV=true` in non-production.

Pipeline (`/api/pipeline/*`) always requires a real `PIPELINE_TOKEN` (fail-closed).

## Public Cloudflare panel (`:18080`)

`tools/client-public.mjs` proxies **only**:

- `/health`
- `/api/client-auth/*`
- `/api/client/*`
- `/ws/client`

Admin, trading, robot-desk, pipeline, and `/ws` return **404** on the public port. `tools/check-public.mjs` asserts this.

## Operational controls

- LIVE trading disabled unless `LIVE_TRADING_ENABLED=true` (control-api defaults **false**; market-core refuses LIVE otherwise).  
- `POST /api/system/mode` to LIVE requires the live flag already set — it does **not** auto-enable LIVE.  
- Audit log records client/broker/instrument mutations (`audit_logs`).  
- Secrets must not appear in dashboard bundles, git, or plaintext DB columns.  
- Postgres/Redis published on `127.0.0.1` only (`docker-compose.yml`).

## Testing

- C++: `tests/security/test_security.cpp` — env placeholders / gitignore  
- Node: `apps/control-api/src/security/encryption.test.ts` — encrypt/decrypt/mask + placeholder refuse  
- Proof: `apps/control-api/src/services/fullSystemAudit.proof.test.ts` — public proxy allowlist, auth, Capital lock, fanout
