import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { logAudit } from '../services/audit.js';

async function hardDeleteClient(clientId: string): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const accounts = await db.query(
      `SELECT ba.id
       FROM broker_accounts ba
       JOIN broker_connections bc ON bc.id = ba.broker_connection_id
       WHERE bc.client_id = $1`,
      [clientId]
    );
    const accountIds = accounts.rows.map((r) => r.id as number);
    if (accountIds.length > 0) {
      await db.query('DELETE FROM account_instrument_settings WHERE broker_account_id = ANY($1::int[])', [accountIds]);
      await db.query('DELETE FROM positions WHERE broker_account_id = ANY($1::int[])', [accountIds]);
      await db.query('DELETE FROM executions WHERE broker_account_id = ANY($1::int[])', [accountIds]);
      await db.query('DELETE FROM trades WHERE broker_account_id = ANY($1::int[])', [accountIds]);
    }
    const conns = await db.query(
      'SELECT id FROM broker_connections WHERE client_id = $1',
      [clientId]
    );
    const connIds = conns.rows.map((r) => r.id as number);
    if (connIds.length > 0) {
      await db.query(
        'DELETE FROM api_credential_metadata WHERE broker_connection_id = ANY($1::int[])',
        [connIds]
      );
      await db.query(
        'DELETE FROM broker_accounts WHERE broker_connection_id = ANY($1::int[])',
        [connIds]
      );
      await db.query('DELETE FROM broker_connections WHERE id = ANY($1::int[])', [connIds]);
    }
    await db.query('DELETE FROM clients WHERE id = $1', [clientId]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}

export async function registerClientRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/clients', async () => {
    const { rows } = await pool.query(
      'SELECT * FROM clients ORDER BY created_at DESC'
    );
    return rows;
  });

  app.get('/api/clients/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (rows.length === 0) return { error: 'Not found' };
    const accounts = await pool.query(
      `SELECT ba.*, bc.broker_name, bc.environment
       FROM broker_accounts ba
       JOIN broker_connections bc ON bc.id = ba.broker_connection_id
       WHERE bc.client_id = $1`,
      [id]
    );
    return { ...rows[0], accounts: accounts.rows };
  });

  app.post('/api/clients', async (request) => {
    const body = request.body as { name: string };
    const { rows } = await pool.query(
      'INSERT INTO clients (name) VALUES ($1) RETURNING *',
      [body.name]
    );
    await logAudit('admin', 'client_created', 'client', String(rows[0].id), null, rows[0]);
    return rows[0];
  });

  app.put('/api/clients/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; enabled?: boolean };
    const prev = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    const { rows } = await pool.query(
      `UPDATE clients SET
        name = COALESCE($2, name),
        enabled = COALESCE($3, enabled),
        updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, body.name, body.enabled]
    );
    await logAudit('admin', 'client_updated', 'client', id, prev.rows[0], rows[0]);
    return rows[0];
  });

  app.delete('/api/clients/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { hard?: string };
    const prev = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (prev.rows.length === 0) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    if (query.hard === '1' || query.hard === 'true') {
      await hardDeleteClient(id);
      await logAudit('admin', 'client_deleted', 'client', id, prev.rows[0], { deleted: true });
      return { success: true, hard: true };
    }

    await pool.query(
      'UPDATE clients SET enabled = false, updated_at = NOW() WHERE id = $1',
      [id]
    );
    await logAudit('admin', 'client_disabled', 'client', id, prev.rows[0], { enabled: false });
    return { success: true, hard: false };
  });
}
