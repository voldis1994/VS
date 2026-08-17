import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { encrypt, decrypt, maskSecret } from '../security/encryption.js';
import { logAudit } from '../services/audit.js';
import { acquireCapitalSession, fetchAllCapitalMarkets, listCapitalAccounts, testCapitalComSession } from '../services/capitalCom.js';
import { ensureBrokerAccount, seedAccountInstruments } from './trading.js';

/** Simple in-process rate limiter: max 10 requests per IP per 60 s for write endpoints. */
const _brokerWriteHits = new Map<string, number[]>();
function brokerWriteAllowed(ip: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const max = 10;
  const hits = (_brokerWriteHits.get(ip) ?? []).filter((t) => now - t < window);
  if (hits.length >= max) { _brokerWriteHits.set(ip, hits); return false; }
  hits.push(now);
  _brokerWriteHits.set(ip, hits);
  return true;
}

async function ensureClientId(preferredId: number | undefined, fallbackName: string): Promise<number> {
  if (preferredId && Number.isFinite(preferredId) && preferredId > 0) {
    const existing = await pool.query('SELECT id FROM clients WHERE id = $1', [preferredId]);
    if (existing.rows.length > 0) return preferredId;
  }

  const any = await pool.query('SELECT id FROM clients WHERE enabled = true ORDER BY id ASC LIMIT 1');
  if (any.rows.length > 0) return any.rows[0].id as number;

  const created = await pool.query(
    'INSERT INTO clients (name) VALUES ($1) RETURNING id',
    [fallbackName || 'Default Client']
  );
  return created.rows[0].id as number;
}

async function loadCredentialMap(brokerConnectionId: number): Promise<Record<string, string>> {
  const { rows } = await pool.query(
    `SELECT credential_type, ciphertext, iv, tag
     FROM api_credential_metadata
     WHERE broker_connection_id = $1`,
    [brokerConnectionId]
  );
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.credential_type as string] = decrypt(
      row.ciphertext as string,
      row.iv as string,
      row.tag as string
    );
  }
  return out;
}

export async function registerBrokerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/brokers', async () => {
    const { rows } = await pool.query(
      `SELECT bc.*, c.name as client_name
       FROM broker_connections bc
       JOIN clients c ON c.id = bc.client_id
       ORDER BY bc.created_at DESC`
    );
    return rows;
  });

  app.get('/api/brokers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      'SELECT * FROM broker_connections WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return { error: 'Not found' };
    const creds = await pool.query(
      'SELECT id, credential_type, masked_value, created_at FROM api_credential_metadata WHERE broker_connection_id = $1',
      [id]
    );
    return { ...rows[0], credentials: creds.rows };
  });

  app.post('/api/brokers', async (request, reply) => {
    try {
      const body = request.body as {
        client_id?: number;
        broker_name: string;
        environment: string;
        identifier?: string;
        api_key?: string;
        password?: string;
      };

      if (!body.broker_name?.trim()) {
        return reply.code(400).send({ error: 'broker_name is required' });
      }
      if (!body.environment?.trim()) {
        return reply.code(400).send({ error: 'environment is required' });
      }
      if (body.broker_name === 'capital_com') {
        if (!body.identifier?.trim()) {
          return reply.code(400).send({ error: 'Identifier (login email) is required' });
        }
        if (!body.api_key?.trim() || !body.password?.trim()) {
          return reply.code(400).send({
            error: 'Capital.com needs API Key AND API Password (from Capital.com → Settings → API)',
          });
        }
        if (body.api_key.includes('@')) {
          return reply.code(400).send({
            error:
              'API Key looks like an email. Put email in Identifier, and paste the Capital.com API Key in API Key.',
          });
        }
      }

      const clientId = await ensureClientId(
        body.client_id !== undefined ? Number(body.client_id) : undefined,
        body.identifier?.trim() || 'Default Client'
      );

      const { rows } = await pool.query(
        `INSERT INTO broker_connections (client_id, broker_name, environment, identifier)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [clientId, body.broker_name, body.environment, body.identifier || null]
      );

      const conn = rows[0];

      if (body.api_key) {
        const enc = encrypt(body.api_key);
        await pool.query(
          `INSERT INTO api_credential_metadata
           (broker_connection_id, credential_type, ciphertext, iv, tag, masked_value)
           VALUES ($1, 'api_key', $2, $3, $4, $5)`,
          [conn.id, enc.ciphertext, enc.iv, enc.tag, maskSecret(body.api_key)]
        );
      }
      if (body.password) {
        const enc = encrypt(body.password);
        await pool.query(
          `INSERT INTO api_credential_metadata
           (broker_connection_id, credential_type, ciphertext, iv, tag, masked_value)
           VALUES ($1, 'password', $2, $3, $4, $5)`,
          [conn.id, enc.ciphertext, enc.iv, enc.tag, maskSecret(body.password)]
        );
      }

      await logAudit('admin', 'broker_added', 'broker_connection', String(conn.id), null, {
        broker_name: body.broker_name,
        environment: body.environment,
        client_id: clientId,
      });

      const client = await pool.query('SELECT name FROM clients WHERE id = $1', [clientId]);
      const clientName = (client.rows[0]?.name as string) || 'Default Client';
      const accountId = await ensureBrokerAccount(
        conn.id as number,
        `${clientName} / ${body.broker_name} (${body.environment})`
      );
      await seedAccountInstruments(accountId);

      return {
        ...conn,
        client_name: clientName,
        account_id: accountId,
        credentials: [],
      };
    } catch (err) {
      request.log.error(err);
      const message = err instanceof Error ? err.message : 'Failed to save broker connection';
      return reply.code(500).send({ error: message });
    }
  });

  app.post('/api/brokers/:id/test', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { rows } = await pool.query(
        'SELECT * FROM broker_connections WHERE id = $1',
        [id]
      );
      if (rows.length === 0) {
        return reply.code(404).send({ success: false, error: 'Broker connection not found' });
      }

      const conn = rows[0] as {
        id: number;
        broker_name: string;
        environment: string;
        identifier: string | null;
      };

      if (conn.broker_name === 'paper') {
        return {
          success: true,
          message: 'Paper broker OK (no external API call)',
        };
      }

      if (conn.broker_name !== 'capital_com') {
        return reply.code(400).send({
          success: false,
          error: `Unsupported broker for live test: ${conn.broker_name}`,
        });
      }

      const creds = await loadCredentialMap(conn.id);
      const apiKey = creds.api_key || '';
      const password = creds.password || '';
      const identifier = (conn.identifier || '').trim();

      if (!identifier) {
        return reply.code(400).send({
          success: false,
          error: 'Missing identifier (login email) on this connection. Save again with Identifier filled.',
        });
      }
      if (!apiKey || !password) {
        return reply.code(400).send({
          success: false,
          error: 'Missing stored API Key or Password. Delete/re-add the connection with both fields.',
        });
      }
      if (apiKey.includes('@')) {
        return reply.code(400).send({
          success: false,
          error:
            'Stored API Key looks like an email. Re-save: Identifier = email, API Key = Capital.com API key, Password = API password.',
        });
      }

      const result = await testCapitalComSession({
        environment: conn.environment,
        apiKey,
        identifier,
        password,
      });

      if (!result.ok) {
        // 200 + success:false so UI always receives the detailed error body
        return {
          success: false,
          error: result.detail,
          status: result.status,
          errorCode: result.errorCode,
        };
      }

      // Sync Capital.com multi-accounts onto this connection (external_account_id)
      let syncedAccounts: Array<{ accountId: string; accountName: string }> = [];
      try {
        const opened = await acquireCapitalSession({
          environment: conn.environment,
          apiKey,
          identifier,
          password,
          connectionId: conn.id,
        });
        if (opened.ok) {
          const listed = await listCapitalAccounts(opened.session);
          if (listed.ok && listed.accounts.length) {
            syncedAccounts = listed.accounts.map((a) => ({
              accountId: a.accountId,
              accountName: a.accountName,
            }));
            for (const a of listed.accounts) {
              const existing = await pool.query(
                `SELECT id FROM broker_accounts
                 WHERE broker_connection_id = $1 AND external_account_id = $2`,
                [conn.id, a.accountId]
              );
              if (existing.rows.length) {
                await pool.query(
                  `UPDATE broker_accounts SET display_name = $1 WHERE id = $2`,
                  [a.accountName || a.accountId, existing.rows[0].id]
                );
              } else {
                // Prefer filling the first account row if it has no external id yet
                const blank = await pool.query(
                  `SELECT id FROM broker_accounts
                   WHERE broker_connection_id = $1 AND (external_account_id IS NULL OR external_account_id = '')
                   ORDER BY id ASC LIMIT 1`,
                  [conn.id]
                );
                if (blank.rows.length) {
                  await pool.query(
                    `UPDATE broker_accounts
                     SET external_account_id = $1, display_name = COALESCE(NULLIF(display_name,''), $2)
                     WHERE id = $3`,
                    [a.accountId, a.accountName || a.accountId, blank.rows[0].id]
                  );
                } else {
                  await pool.query(
                    `INSERT INTO broker_accounts (broker_connection_id, external_account_id, display_name, enabled)
                     VALUES ($1, $2, $3, true)`,
                    [conn.id, a.accountId, a.accountName || a.accountId]
                  );
                }
              }
            }
          }
        }
      } catch {
        /* test already OK — sync is best-effort */
      }

      return {
        success: true,
        message: result.detail,
        accountType: result.accountType,
        capital_accounts: syncedAccounts,
        multi_account: syncedAccounts.length > 1,
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({
        success: false,
        error: err instanceof Error ? err.message : 'Connection test failed',
      });
    }
  });

  app.delete('/api/brokers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { hard?: string };
    const prev = await pool.query('SELECT * FROM broker_connections WHERE id = $1', [id]);
    if (prev.rows.length === 0) {
      return reply.code(404).send({ error: 'Broker connection not found' });
    }

    if (query.hard === '1' || query.hard === 'true') {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const accounts = await db.query(
          'SELECT id FROM broker_accounts WHERE broker_connection_id = $1',
          [id]
        );
        const accountIds = accounts.rows.map((r) => r.id as number);
        if (accountIds.length > 0) {
          await db.query('DELETE FROM account_instrument_settings WHERE broker_account_id = ANY($1::int[])', [accountIds]);
          await db.query('DELETE FROM positions WHERE broker_account_id = ANY($1::int[])', [accountIds]);
          await db.query('DELETE FROM executions WHERE broker_account_id = ANY($1::int[])', [accountIds]);
          await db.query('DELETE FROM trades WHERE broker_account_id = ANY($1::int[])', [accountIds]);
          await db.query('DELETE FROM broker_accounts WHERE id = ANY($1::int[])', [accountIds]);
        }
        await db.query('DELETE FROM api_credential_metadata WHERE broker_connection_id = $1', [id]);
        await db.query('DELETE FROM broker_connections WHERE id = $1', [id]);
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      } finally {
        db.release();
      }
      await logAudit('admin', 'broker_deleted', 'broker_connection', id, prev.rows[0], { deleted: true });
      return { success: true, hard: true };
    }

    await pool.query('UPDATE broker_connections SET enabled = false WHERE id = $1', [id]);
    await logAudit('admin', 'broker_disabled', 'broker_connection', id, prev.rows[0], { enabled: false });
    return { success: true, hard: false };
  });

  // POST /api/brokers/:id/disable — explicit disable without delete
  app.post('/api/brokers/:id/disable', async (request, reply) => {
    const ip = (request.ip ?? 'unknown').replace(/^::ffff:/, '');
    if (!brokerWriteAllowed(ip)) return reply.code(429).send({ error: 'Too many requests' });
    const { id } = request.params as { id: string };
    const prev = await pool.query('SELECT * FROM broker_connections WHERE id = $1', [id]);
    if (!prev.rows.length) return reply.code(404).send({ error: 'Broker connection not found' });
    await pool.query('UPDATE broker_connections SET enabled = false WHERE id = $1', [id]);
    await logAudit('admin', 'broker_disabled', 'broker_connection', id, prev.rows[0], { enabled: false });
    return { success: true, message: 'Broker disabled. New orders blocked.' };
  });

  // POST /api/brokers/:id/pull-markets — fetch full Capital.com market tree, upsert, then seed
  app.post('/api/brokers/:id/pull-markets', async (request, reply) => {
    const ip = (request.ip ?? 'unknown').replace(/^::ffff:/, '');
    if (!brokerWriteAllowed(ip)) return reply.code(429).send({ error: 'Too many requests' });
    const { id } = request.params as { id: string };

    const connRows = await pool.query('SELECT * FROM broker_connections WHERE id = $1', [id]);
    if (!connRows.rows.length) return reply.code(404).send({ error: 'Broker connection not found' });
    const conn = connRows.rows[0] as {
      id: number;
      broker_name: string;
      environment: string;
      identifier: string | null;
    };

    if (conn.broker_name !== 'capital_com') {
      return reply.code(400).send({ error: 'Only capital_com connections can pull live markets.' });
    }

    const creds = await loadCredentialMap(conn.id);
    const apiKey = creds.api_key || '';
    const password = creds.password || '';
    const identifier = (conn.identifier || '').trim();

    if (!apiKey || !password || !identifier) {
      return reply.code(400).send({
        error: 'MISSING_CREDENTIALS',
        message: 'Missing Capital.com credentials on this broker connection. Re-save in Brokers first.',
      });
    }

    const opened = await acquireCapitalSession({
      environment: conn.environment,
      apiKey,
      identifier,
      password,
      connectionId: conn.id,
    });
    if (!opened.ok) {
      return reply.code(400).send({
        error: 'CAPITAL_SESSION_FAILED',
        message: opened.result?.detail || 'Capital.com session could not be established.',
      });
    }

    const markets = await fetchAllCapitalMarkets(opened.session);
    if (markets.length === 0) {
      return reply.code(502).send({
        error: 'NO_MARKETS',
        message: 'Capital.com returned 0 markets. Check Live/Demo environment and API key permissions.',
      });
    }

    // Upsert Capital.com catalog
    for (const m of markets) {
      await pool.query(
        `INSERT INTO capital_markets
         (broker_connection_id, epic, symbol, display_name, instrument_type, category, min_lot, max_lot, lot_step)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (broker_connection_id, epic) DO UPDATE SET
           symbol = EXCLUDED.symbol,
           display_name = EXCLUDED.display_name,
           instrument_type = EXCLUDED.instrument_type,
           category = EXCLUDED.category,
           min_lot = EXCLUDED.min_lot,
           max_lot = EXCLUDED.max_lot,
           lot_step = EXCLUDED.lot_step,
           updated_at = NOW()`,
        [
          conn.id, m.epic, m.epic, m.display_name,
          m.instrument_type || null, m.category || null,
          m.min_lot ?? 0.01, m.max_lot ?? 1000, m.lot_step ?? 0.01,
        ]
      );
    }

    // Seed account instrument settings from the refreshed catalog
    const { rows: accs } = await pool.query(
      `SELECT id FROM broker_accounts
       WHERE broker_connection_id = $1 AND enabled = true ORDER BY id ASC LIMIT 1`,
      [id]
    );
    if (accs.length) {
      await seedAccountInstruments(accs[0].id as number);
    }

    await logAudit('admin', 'capital_markets_pulled', 'broker_connection', id, null, {
      count: markets.length,
      environment: conn.environment,
    });

    return {
      success: true,
      count: markets.length,
      message: `Capital market catalog refreshed. ${markets.length} instruments loaded.`,
      sample: markets.slice(0, 8).map((m) => ({ epic: m.epic, name: m.display_name })),
    };
  });
}
