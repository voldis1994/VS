import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';

export async function registerTradeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/trades', async (request) => {
    const query = request.query as {
      client_id?: string;
      instrument_id?: string;
      direction?: string;
      limit?: string;
    };
    let sql = `SELECT t.*, c.name as client_name
               FROM trades t
               JOIN broker_accounts ba ON ba.id = t.broker_account_id
               JOIN broker_connections bc ON bc.id = ba.broker_connection_id
               JOIN clients c ON c.id = bc.client_id
               WHERE 1=1`;
    const params: unknown[] = [];
    let idx = 1;

    if (query.client_id) {
      sql += ` AND bc.client_id = $${idx++}`;
      params.push(query.client_id);
    }
    if (query.instrument_id) {
      sql += ` AND t.instrument_id = $${idx++}`;
      params.push(query.instrument_id);
    }
    if (query.direction) {
      sql += ` AND t.direction = $${idx++}`;
      params.push(query.direction);
    }

    sql += ` ORDER BY t.closed_at DESC NULLS LAST LIMIT $${idx}`;
    params.push(parseInt(query.limit || '50', 10));

    const { rows } = await pool.query(sql, params);
    return rows;
  });

  app.get('/api/trades/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await pool.query('SELECT * FROM trades WHERE id = $1', [id]);
    if (rows.length === 0) return { error: 'Not found' };

    const trade = rows[0];
    const intent = trade.setup_id
      ? await pool.query('SELECT * FROM trade_intents WHERE setup_id = $1 LIMIT 1', [trade.setup_id])
      : { rows: [] };
    const evidence = intent.rows[0]?.evidence_report_id
      ? await pool.query('SELECT * FROM evidence_reports WHERE id = $1', [intent.rows[0].evidence_report_id])
      : { rows: [] };

    return {
      trade,
      intent: intent.rows[0] || null,
      evidence: evidence.rows[0] || null,
    };
  });

  app.get('/api/intents', async () => {
    const { rows } = await pool.query(
      'SELECT * FROM trade_intents ORDER BY created_at DESC LIMIT 50'
    );
    return rows;
  });
}
