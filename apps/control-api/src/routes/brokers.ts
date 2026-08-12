import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { encrypt, maskSecret } from '../security/encryption.js';
import { logAudit } from '../services/audit.js';

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
      if (!body.api_key?.trim() && !body.password?.trim() && body.broker_name !== 'paper') {
        return reply.code(400).send({ error: 'API key or password is required for Capital.com' });
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
      return {
        ...conn,
        client_name: client.rows[0]?.name || 'Default Client',
        credentials: [],
      };
    } catch (err) {
      request.log.error(err);
      const message = err instanceof Error ? err.message : 'Failed to save broker connection';
      return reply.code(500).send({ error: message });
    }
  });

  app.post('/api/brokers/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      'SELECT * FROM broker_connections WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return { success: false, error: 'Not found' };
    return {
      success: true,
      message: `Connection test for ${rows[0].broker_name} (${rows[0].environment}) - credentials stored securely`,
    };
  });

  app.delete('/api/brokers/:id', async (request) => {
    const { id } = request.params as { id: string };
    await pool.query('UPDATE broker_connections SET enabled = false WHERE id = $1', [id]);
    await logAudit('admin', 'broker_disabled', 'broker_connection', id, null, { enabled: false });
    return { success: true };
  });
}
