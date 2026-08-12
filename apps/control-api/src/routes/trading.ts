import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { logAudit } from '../services/audit.js';
import { getEnabledInstruments, getInstrumentById } from '../config/instruments.js';

export async function ensureBrokerAccount(connectionId: number, displayName: string): Promise<number> {
  const existing = await pool.query(
    'SELECT id FROM broker_accounts WHERE broker_connection_id = $1 ORDER BY id ASC LIMIT 1',
    [connectionId]
  );
  if (existing.rows.length > 0) return existing.rows[0].id as number;

  const created = await pool.query(
    `INSERT INTO broker_accounts (broker_connection_id, display_name, enabled)
     VALUES ($1, $2, true) RETURNING id`,
    [connectionId, displayName]
  );
  return created.rows[0].id as number;
}

export async function seedAccountInstruments(accountId: number): Promise<void> {
  for (const inst of getEnabledInstruments()) {
    await pool.query(
      `INSERT INTO account_instrument_settings
       (broker_account_id, instrument_id, symbol, lot_size, enabled, trading_enabled)
       VALUES ($1, $2, $3, $4, true, false)
       ON CONFLICT (broker_account_id, instrument_id) DO NOTHING`,
      [accountId, inst.id, inst.symbol, inst.min_lot]
    );
  }
}

export async function registerTradingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/instruments', async () => getEnabledInstruments());

  app.get('/api/trading/accounts', async () => {
    const { rows } = await pool.query(
      `SELECT ba.id as account_id,
              ba.display_name,
              ba.enabled as account_enabled,
              bc.id as connection_id,
              bc.broker_name,
              bc.environment,
              bc.identifier,
              c.id as client_id,
              c.name as client_name
       FROM broker_accounts ba
       JOIN broker_connections bc ON bc.id = ba.broker_connection_id
       JOIN clients c ON c.id = bc.client_id
       WHERE ba.enabled = true AND bc.enabled = true
       ORDER BY ba.id ASC`
    );
    return rows;
  });

  app.post('/api/trading/accounts/sync', async () => {
    const { rows: connections } = await pool.query(
      `SELECT bc.id, bc.broker_name, bc.environment, bc.identifier, c.name as client_name
       FROM broker_connections bc
       JOIN clients c ON c.id = bc.client_id
       WHERE bc.enabled = true`
    );
    const created: number[] = [];
    for (const conn of connections) {
      const name = `${conn.client_name} / ${conn.broker_name} (${conn.environment})`;
      const accountId = await ensureBrokerAccount(conn.id as number, name);
      await seedAccountInstruments(accountId);
      created.push(accountId);
    }
    return { synced_accounts: created.length, account_ids: created };
  });

  app.get('/api/trading/accounts/:accountId/instruments', async (request) => {
    const { accountId } = request.params as { accountId: string };
    const catalog = getEnabledInstruments();
    const { rows } = await pool.query(
      `SELECT * FROM account_instrument_settings WHERE broker_account_id = $1 ORDER BY instrument_id`,
      [accountId]
    );
    const byId = new Map(rows.map((r) => [Number(r.instrument_id), r]));
    return catalog.map((inst) => {
      const row = byId.get(inst.id);
      return {
        instrument_id: inst.id,
        symbol: inst.symbol,
        display_name: inst.display_name,
        category: inst.category,
        min_lot: inst.min_lot,
        max_lot: inst.max_lot,
        lot_step: inst.lot_step,
        lot_size: row ? Number(row.lot_size) : inst.min_lot,
        enabled: row ? Boolean(row.enabled) : false,
        trading_enabled: row ? Boolean(row.trading_enabled) : false,
        configured: Boolean(row),
      };
    });
  });

  app.put('/api/trading/accounts/:accountId/instruments/:instrumentId', async (request, reply) => {
    const { accountId, instrumentId } = request.params as { accountId: string; instrumentId: string };
    const body = request.body as {
      lot_size?: number;
      enabled?: boolean;
      trading_enabled?: boolean;
    };

    const inst = getInstrumentById(parseInt(instrumentId, 10));
    if (!inst) {
      return reply.code(404).send({ error: `Unknown instrument ${instrumentId}` });
    }

    let lot = body.lot_size;
    if (lot !== undefined) {
      if (lot < inst.min_lot || lot > inst.max_lot) {
        return reply.code(400).send({
          error: `lot_size must be between ${inst.min_lot} and ${inst.max_lot} for ${inst.symbol}`,
        });
      }
      const steps = Math.round(lot / inst.lot_step);
      lot = Number((steps * inst.lot_step).toFixed(8));
    }

    const prev = await pool.query(
      'SELECT * FROM account_instrument_settings WHERE broker_account_id = $1 AND instrument_id = $2',
      [accountId, instrumentId]
    );

    const { rows } = await pool.query(
      `INSERT INTO account_instrument_settings
       (broker_account_id, instrument_id, symbol, lot_size, enabled, trading_enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (broker_account_id, instrument_id)
       DO UPDATE SET
         symbol = EXCLUDED.symbol,
         lot_size = COALESCE($4, account_instrument_settings.lot_size),
         enabled = COALESCE($5, account_instrument_settings.enabled),
         trading_enabled = COALESCE($6, account_instrument_settings.trading_enabled),
         updated_at = NOW()
       RETURNING *`,
      [
        accountId,
        instrumentId,
        inst.symbol,
        lot ?? prev.rows[0]?.lot_size ?? inst.min_lot,
        body.enabled ?? prev.rows[0]?.enabled ?? true,
        body.trading_enabled ?? prev.rows[0]?.trading_enabled ?? false,
      ]
    );

    await logAudit(
      'admin',
      'instrument_settings_updated',
      'account_instrument_settings',
      `${accountId}:${instrumentId}`,
      prev.rows[0] || null,
      rows[0]
    );
    return rows[0];
  });
}
