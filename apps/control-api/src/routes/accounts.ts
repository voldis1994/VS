import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { logAudit } from '../services/audit.js';

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/accounts/:id/instruments', async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      'SELECT * FROM account_instrument_settings WHERE broker_account_id = $1',
      [id]
    );
    return rows;
  });

  app.put('/api/accounts/:id/instruments/:instrumentId', async (request) => {
    const { id, instrumentId } = request.params as { id: string; instrumentId: string };
    const body = request.body as {
      lot_size?: number;
      enabled?: boolean;
      trading_enabled?: boolean;
      symbol?: string;
    };

    const prev = await pool.query(
      'SELECT * FROM account_instrument_settings WHERE broker_account_id = $1 AND instrument_id = $2',
      [id, instrumentId]
    );

    const { rows } = await pool.query(
      `INSERT INTO account_instrument_settings
       (broker_account_id, instrument_id, symbol, lot_size, enabled, trading_enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (broker_account_id, instrument_id)
       DO UPDATE SET
         lot_size = COALESCE($4, account_instrument_settings.lot_size),
         enabled = COALESCE($5, account_instrument_settings.enabled),
         trading_enabled = COALESCE($6, account_instrument_settings.trading_enabled),
         updated_at = NOW()
       RETURNING *`,
      [
        id,
        instrumentId,
        body.symbol || `INST_${instrumentId}`,
        body.lot_size ?? 0.01,
        body.enabled ?? true,
        body.trading_enabled ?? false,
      ]
    );

    await logAudit('admin', 'instrument_settings_updated', 'account_instrument_settings',
      `${id}:${instrumentId}`, prev.rows[0] || null, rows[0]);
    return rows[0];
  });

  app.get('/api/positions', async () => {
    const { rows } = await pool.query(
      `SELECT p.*, ba.display_name as account_name, c.name as client_name
       FROM positions p
       JOIN broker_accounts ba ON ba.id = p.broker_account_id
       JOIN broker_connections bc ON bc.id = ba.broker_connection_id
       JOIN clients c ON c.id = bc.client_id
       WHERE p.status = 'OPEN'
       ORDER BY p.opened_at DESC`
    );
    return rows;
  });
}
