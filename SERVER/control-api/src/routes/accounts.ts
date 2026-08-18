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

  app.put('/api/accounts/:id/instruments/:instrumentId', async (request, reply) => {
    const { id, instrumentId } = request.params as { id: string; instrumentId: string };
    const body = request.body as {
      lot_size?: number;
      enabled?: boolean;
      trading_enabled?: boolean;
      symbol?: string;
    };

    // Validate lot_size: must be a finite positive number when provided.
    if (body.lot_size !== undefined) {
      if (
        typeof body.lot_size !== 'number' ||
        !Number.isFinite(body.lot_size) ||
        body.lot_size <= 0
      ) {
        return reply.code(400).send({
          error: 'lot_size must be a finite positive number',
        });
      }
    }

    // Verify instrument belongs to this broker account via the capital_markets catalog.
    const instrumentCheck = await pool.query(
      `SELECT cm.id, cm.epic, cm.min_lot, cm.max_lot, cm.lot_step
       FROM capital_markets cm
       JOIN broker_accounts ba ON ba.broker_connection_id = cm.broker_connection_id
       WHERE cm.id = $1 AND ba.id = $2
       LIMIT 1`,
      [instrumentId, id]
    );
    if (!instrumentCheck.rows.length) {
      return reply.code(404).send({
        error: 'instrument_id not found for this account — pull markets first',
      });
    }
    const catalog = instrumentCheck.rows[0] as {
      id: number;
      epic: string;
      min_lot: number;
      max_lot: number;
      lot_step: number;
    };

    // Validate lot_size against broker catalog constraints when provided.
    if (body.lot_size !== undefined) {
      if (body.lot_size < catalog.min_lot || body.lot_size > catalog.max_lot) {
        return reply.code(400).send({
          error: `lot_size ${body.lot_size} is outside broker limits [${catalog.min_lot}, ${catalog.max_lot}]`,
        });
      }
      const step = catalog.lot_step > 0 ? catalog.lot_step : 0.01;
      const remainder = Math.round((body.lot_size / step) * 1e10) % 1e10;
      if (remainder !== 0) {
        return reply.code(400).send({
          error: `lot_size ${body.lot_size} is not a multiple of lot_step ${step}`,
        });
      }
    }

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
        body.symbol || catalog.epic,
        body.lot_size ?? catalog.min_lot,
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
