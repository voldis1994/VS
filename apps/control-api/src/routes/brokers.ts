import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { encrypt, decrypt, maskSecret } from '../security/encryption.js';
import { logAudit } from '../services/audit.js';
import { testCapitalComSession } from '../services/capitalCom.js';
import { ensureBrokerAccount, seedAccountInstruments } from './trading.js';

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
        return reply.code(400).send({
          success: false,
          error: result.detail,
          status: result.status,
        });
      }

      return {
        success: true,
        message: result.detail,
        accountType: result.accountType,
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({
        success: false,
        error: err instanceof Error ? err.message : 'Connection test failed',
      });
    }
  });

  app.delete('/api/brokers/:id', async (request) => {
    const { id } = request.params as { id: string };
    await pool.query('UPDATE broker_connections SET enabled = false WHERE id = $1', [id]);
    await logAudit('admin', 'broker_disabled', 'broker_connection', id, null, { enabled: false });
    return { success: true };
  });
}
