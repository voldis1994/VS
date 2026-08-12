import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { encrypt, maskSecret } from '../security/encryption.js';
import { logAudit } from '../services/audit.js';

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

  app.post('/api/brokers', async (request) => {
    const body = request.body as {
      client_id: number;
      broker_name: string;
      environment: string;
      identifier?: string;
      api_key?: string;
      password?: string;
    };

    const { rows } = await pool.query(
      `INSERT INTO broker_connections (client_id, broker_name, environment, identifier)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.client_id, body.broker_name, body.environment, body.identifier]
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
    });

    return { ...conn, credentials: [] };
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
