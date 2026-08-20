import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/audit', async (request) => {
    const query = request.query as { limit?: string; action?: string };
    let sql = 'SELECT * FROM audit_logs WHERE 1=1';
    const params: unknown[] = [];
    let idx = 1;

    if (query.action) {
      sql += ` AND action = $${idx++}`;
      params.push(query.action);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
    params.push(parseInt(query.limit || '100', 10));

    const { rows } = await pool.query(sql, params);
    return rows;
  });
}
