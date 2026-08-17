/**
 * Admin Live-Control API
 *
 * GET  /api/admin/live-control         — current live-trading state
 * POST /api/admin/live-control/enable  — enable LIVE (full safety gate)
 * POST /api/admin/live-control/disable — disable LIVE immediately
 *
 * All endpoints require a valid x-admin-token.
 * LIVE_TRADING_ENABLED is persisted to /var/lib/vs-server/server.env so
 * the operator value survives a service restart.  The systemd unit no
 * longer hardcodes the value — it reads the file via EnvironmentFile=.
 */
import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { pool } from '../db/pool.js';
import { isUnsafeMasterEncryptionKey } from '../security/encryption.js';
import { testCapitalComSession } from '../services/capitalCom.js';
import { decrypt } from '../security/encryption.js';
import { getMoneyPathGate } from '../vs-core/moneyPathGate.js';
import { logAudit } from '../services/audit.js';

/** Path to the durable operator env file. */
function serverEnvPath(): string {
  return path.join(
    process.env.VS_SERVER_DATA || process.env.VS_CORE_DATA || '/var/lib/vs-server',
    'server.env'
  );
}

/** Read a key from the env file (returns '' if absent). */
function readEnvKey(envFile: string, key: string): string {
  try {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith(`${key}=`)) {
        return t.slice(key.length + 1).trim();
      }
    }
  } catch {
    // file absent is fine
  }
  return '';
}

/** Write or overwrite a key=value line in the env file (atomic). */
function writeEnvKey(envFile: string, key: string, value: string): void {
  let content = '';
  try {
    content = fs.readFileSync(envFile, 'utf8');
  } catch {
    content = '';
  }
  const lines = content.split('\n');
  let found = false;
  const updated = lines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    updated.push(`${key}=${value}`);
  }
  const out = updated.join('\n').replace(/\n{3,}/g, '\n\n');
  const tmp = `${envFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, { encoding: 'utf8', mode: 0o640 });
  fs.renameSync(tmp, envFile);
}

function liveEnabled(): boolean {
  const v = process.env.LIVE_TRADING_ENABLED;
  if (!v) return false;
  return v === 'true' || v === '1';
}

function safeSecrets(): boolean {
  const badSecrets = [
    isUnsafeMasterEncryptionKey(process.env.MASTER_ENCRYPTION_KEY),
    !process.env.DB_PASSWORD || process.env.DB_PASSWORD === 'CHANGE_ME',
    !process.env.API_ADMIN_TOKEN || process.env.API_ADMIN_TOKEN === 'CHANGE_ME_ADMIN_TOKEN',
  ].some(Boolean);
  return !badSecrets;
}

async function findLiveBroker(): Promise<{
  id: number;
  identifier: string;
  creds: Record<string, string>;
} | null> {
  const { rows } = await pool.query(
    `SELECT bc.id, bc.identifier,
            a.ciphertext AS api_key_cipher, a.iv AS api_key_iv, a.tag AS api_key_tag,
            p.ciphertext AS api_pw_cipher,  p.iv AS api_pw_iv,  p.tag AS api_pw_tag
     FROM broker_connections bc
     LEFT JOIN api_credential_metadata a
       ON a.broker_connection_id = bc.id AND a.credential_type = 'api_key'
     LEFT JOIN api_credential_metadata p
       ON p.broker_connection_id = bc.id AND p.credential_type = 'api_password'
     WHERE bc.broker_name = 'capital_com'
       AND bc.environment = 'live'
       AND bc.enabled = true
     ORDER BY bc.created_at DESC
     LIMIT 1`
  );
  if (!rows.length) return null;
  const r = rows[0] as Record<string, string | null>;
  const creds: Record<string, string> = {};
  if (r.api_key_cipher && r.api_key_iv && r.api_key_tag)
    creds.api_key = decrypt(r.api_key_cipher, r.api_key_iv, r.api_key_tag);
  if (r.api_pw_cipher && r.api_pw_iv && r.api_pw_tag)
    creds.api_password = decrypt(r.api_pw_cipher, r.api_pw_iv, r.api_pw_tag);
  return { id: Number(r.id), identifier: String(r.identifier ?? ''), creds };
}

async function findLiveAccount(brokerConnectionId: number): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT deal_account_id FROM accounts
     WHERE broker_connection_id = $1 AND enabled = true
     ORDER BY created_at ASC LIMIT 1`,
    [brokerConnectionId]
  );
  return rows.length ? (rows[0].deal_account_id as string) : null;
}

function adminTokenOk(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  const expected = process.env.API_ADMIN_TOKEN || '';
  if (!expected || expected === 'CHANGE_ME_ADMIN_TOKEN') return false;
  const sent = String(
    request.headers['x-admin-token'] ?? request.headers['authorization'] ?? ''
  ).replace(/^Bearer\s+/i, '');
  return sent === expected;
}

export async function registerLiveControlRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/live-control
  app.get('/api/admin/live-control', async (request, reply) => {
    if (!adminTokenOk(request as Parameters<typeof adminTokenOk>[0])) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const enabled = liveEnabled();
    const mp = getMoneyPathGate();
    return {
      live_trading_enabled: enabled,
      operating_mode: process.env.OPERATING_MODE || 'PAPER',
      money_path_ready: mp.money_path_ready,
      safe_secrets: safeSecrets(),
      env_file: serverEnvPath(),
    };
  });

  // POST /api/admin/live-control/enable
  app.post('/api/admin/live-control/enable', async (request, reply) => {
    if (!adminTokenOk(request as Parameters<typeof adminTokenOk>[0])) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const body = (request.body as Record<string, unknown>) || {};
    const confirmation = String(body.confirmation ?? '').trim();
    if (confirmation !== 'ENABLE LIVE') {
      return reply.code(400).send({
        error: 'CONFIRMATION_REQUIRED',
        message: 'confirmation must be exactly "ENABLE LIVE"',
      });
    }

    // Gate 1: safe secrets
    if (!safeSecrets()) {
      return reply.code(400).send({
        error: 'UNSAFE_SECRETS',
        message:
          'CHANGE_ME/default secrets detected. Set real MASTER_ENCRYPTION_KEY, DB_PASSWORD, API_ADMIN_TOKEN before enabling LIVE.',
      });
    }

    // Gate 2: live Capital.com broker configured and reachable
    const broker = await findLiveBroker();
    if (!broker) {
      return reply.code(400).send({
        error: 'NO_LIVE_BROKER',
        message:
          'No enabled capital_com broker with environment=live found. Configure broker credentials in Brokers page first.',
      });
    }

    // Gate 3: test real Capital LIVE session
    let sessionTest: Awaited<ReturnType<typeof testCapitalComSession>>;
    try {
      sessionTest = await testCapitalComSession({
        identifier: broker.identifier,
        apiKey: broker.creds.api_key ?? '',
        password: broker.creds.api_password ?? '',
        environment: 'live',
      });
    } catch (e) {
      return reply.code(502).send({
        error: 'CAPITAL_SESSION_FAILED',
        message: `Capital LIVE session test threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    if (!sessionTest.ok) {
      return reply.code(400).send({
        error: 'CAPITAL_LOGIN_FAILED',
        message: sessionTest.detail || 'Capital LIVE login failed',
        errorCode: sessionTest.errorCode,
      });
    }

    // Gate 4: at least one real account
    const account = await findLiveAccount(broker.id);
    if (!account) {
      return reply.code(400).send({
        error: 'NO_LIVE_ACCOUNT',
        message:
          'No enabled account found for the live Capital.com broker. Run SYNC ACCOUNTS in Brokers page first.',
      });
    }

    // Gate 5: money path ready
    const mp = getMoneyPathGate();
    if (!mp.money_path_ready) {
      return reply.code(400).send({
        error: 'MONEY_PATH_NOT_READY',
        message: `Money path is not READY (${mp.reason_code || 'UNKNOWN'}). Resolve open/stuck positions first.`,
      });
    }

    // All gates passed — persist and activate
    const envFile = serverEnvPath();
    try {
      writeEnvKey(envFile, 'LIVE_TRADING_ENABLED', 'true');
    } catch (e) {
      return reply.code(500).send({
        error: 'ENV_WRITE_FAILED',
        message: `Failed to write ${envFile}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    process.env.LIVE_TRADING_ENABLED = 'true';

    await logAudit(
      'admin-api',
      'LIVE_ENABLED',
      'live_control',
      null,
      { live_trading_enabled: false },
      { live_trading_enabled: true, capital_account: account, broker_id: broker.id }
    );

    return {
      ok: true,
      live_trading_enabled: true,
      capital_account: account,
      broker_id: broker.id,
      message: `LIVE TRADING ENABLED. Capital account ${account} is the execution authority. No robot auto-started.`,
    };
  });

  // POST /api/admin/live-control/disable
  app.post('/api/admin/live-control/disable', async (request, reply) => {
    if (!adminTokenOk(request as Parameters<typeof adminTokenOk>[0])) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const envFile = serverEnvPath();
    try {
      writeEnvKey(envFile, 'LIVE_TRADING_ENABLED', 'false');
    } catch (e) {
      return reply.code(500).send({
        error: 'ENV_WRITE_FAILED',
        message: `Failed to write ${envFile}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    // Block new entries immediately
    process.env.LIVE_TRADING_ENABLED = 'false';

    await logAudit(
      'admin-api',
      'LIVE_DISABLED',
      'live_control',
      null,
      { live_trading_enabled: true },
      { live_trading_enabled: false }
    );

    return {
      ok: true,
      live_trading_enabled: false,
      message: 'LIVE TRADING DISABLED. New entries blocked immediately. Existing positions are unaffected.',
    };
  });
}
