import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { decrypt } from '../security/encryption.js';
import { logAudit } from '../services/audit.js';
import { getEnabledInstruments, getInstrumentById } from '../config/instruments.js';
import { fetchAllCapitalMarkets, openCapitalSession } from '../services/capitalCom.js';

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
  // Prefer Capital.com markets for this account's connection when available.
  const link = await pool.query(
    `SELECT ba.id as account_id, ba.broker_connection_id
     FROM broker_accounts ba WHERE ba.id = $1`,
    [accountId]
  );
  if (link.rows.length === 0) return;
  const connectionId = link.rows[0].broker_connection_id as number;

  const capital = await pool.query(
    `SELECT id, epic, display_name, min_lot, max_lot, lot_step
     FROM capital_markets WHERE broker_connection_id = $1 ORDER BY id`,
    [connectionId]
  );

  if (capital.rows.length > 0) {
    for (const m of capital.rows) {
      await pool.query(
        `INSERT INTO account_instrument_settings
         (broker_account_id, instrument_id, symbol, lot_size, enabled, trading_enabled)
         VALUES ($1, $2, $3, $4, true, false)
         ON CONFLICT (broker_account_id, instrument_id) DO UPDATE SET
           symbol = EXCLUDED.symbol,
           updated_at = NOW()`,
        [accountId, m.id, m.epic, m.min_lot]
      );
    }
    return;
  }

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
              c.name as client_name,
              (SELECT COUNT(*)::int FROM capital_markets cm WHERE cm.broker_connection_id = bc.id) as capital_market_count
       FROM broker_accounts ba
       JOIN broker_connections bc ON bc.id = ba.broker_connection_id
       JOIN clients c ON c.id = bc.client_id
       WHERE ba.enabled = true AND bc.enabled = true
       ORDER BY ba.id ASC`
    );
    return rows;
  });

  app.post('/api/trading/accounts/sync', async (_request, reply) => {
    try {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      return reply.code(500).send({ error: message, message });
    }
  });

  /**
   * Pull the full Capital.com market tree (real epics + names) for this trading account.
   * Can take 1–3 minutes depending on account universe size.
   */
  app.post('/api/trading/accounts/:accountId/pull-capital-markets', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    try {
      const { rows } = await pool.query(
        `SELECT ba.id as account_id, bc.id as connection_id, bc.broker_name, bc.environment, bc.identifier
         FROM broker_accounts ba
         JOIN broker_connections bc ON bc.id = ba.broker_connection_id
         WHERE ba.id = $1`,
        [accountId]
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Trading account not found' });
      }
      const conn = rows[0] as {
        account_id: number;
        connection_id: number;
        broker_name: string;
        environment: string;
        identifier: string | null;
      };
      if (conn.broker_name !== 'capital_com') {
        return reply.code(400).send({ error: 'Only Capital.com connections can pull live markets' });
      }

      const creds = await loadCredentialMap(conn.connection_id);
      const apiKey = creds.api_key || '';
      const password = creds.password || '';
      const identifier = (conn.identifier || '').trim();
      if (!apiKey || !password || !identifier) {
        return reply.code(400).send({
          error: 'Missing Capital.com credentials on this broker connection. Re-save Brokers first.',
        });
      }

      const opened = await openCapitalSession({
        environment: conn.environment,
        apiKey,
        identifier,
        password,
      });
      if (!opened.ok) {
        return reply.code(400).send({ error: opened.result.detail, message: opened.result.detail });
      }

      let markets;
      try {
        markets = await fetchAllCapitalMarkets(opened.session);
      } finally {
        await opened.session.close();
      }

      if (markets.length === 0) {
        return reply.code(502).send({
          error: 'Capital.com returned 0 markets. Check Live/Demo environment and API key permissions.',
        });
      }

      // Upsert Capital.com catalog (keep stable IDs via epic unique key).
      const seenEpics: string[] = [];
      for (const m of markets) {
        seenEpics.push(m.epic);
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
            conn.connection_id,
            m.epic,
            m.symbol,
            m.display_name,
            m.instrument_type,
            m.category,
            m.min_lot,
            m.max_lot,
            m.lot_step,
          ]
        );
      }

      // Remove markets that disappeared from Capital.com for this connection.
      if (seenEpics.length > 0) {
        const orphan = await pool.query(
          `SELECT id FROM capital_markets
           WHERE broker_connection_id = $1 AND NOT (epic = ANY($2::text[]))`,
          [conn.connection_id, seenEpics]
        );
        const orphanIds = orphan.rows.map((r) => r.id as number);
        if (orphanIds.length > 0) {
          await pool.query(
            `DELETE FROM account_instrument_settings
             WHERE broker_account_id = $1 AND instrument_id = ANY($2::int[])`,
            [conn.account_id, orphanIds]
          );
          await pool.query('DELETE FROM capital_markets WHERE id = ANY($1::int[])', [orphanIds]);
        }
      }

      await seedAccountInstruments(conn.account_id);
      await logAudit('admin', 'capital_markets_pulled', 'broker_connection', String(conn.connection_id), null, {
        count: markets.length,
        environment: conn.environment,
      });

      return {
        success: true,
        count: markets.length,
        sample: markets.slice(0, 8).map((m) => ({ epic: m.epic, name: m.display_name })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Pull markets failed';
      return reply.code(500).send({ error: message, message });
    }
  });

  app.get('/api/trading/accounts/:accountId/instruments', async (request) => {
    const { accountId } = request.params as { accountId: string };
    const q = request.query as { q?: string; category?: string };

    const link = await pool.query(
      'SELECT broker_connection_id FROM broker_accounts WHERE id = $1',
      [accountId]
    );
    if (link.rows.length === 0) return [];

    const connectionId = link.rows[0].broker_connection_id as number;
    const { rows: settings } = await pool.query(
      `SELECT * FROM account_instrument_settings WHERE broker_account_id = $1`,
      [accountId]
    );
    const settingsById = new Map(settings.map((r) => [Number(r.instrument_id), r]));

    const capital = await pool.query(
      `SELECT * FROM capital_markets WHERE broker_connection_id = $1 ORDER BY display_name ASC`,
      [connectionId]
    );

    if (capital.rows.length > 0) {
      let rows = capital.rows.map((m) => {
        const row = settingsById.get(Number(m.id));
        return {
          instrument_id: Number(m.id),
          epic: m.epic as string,
          symbol: m.epic as string,
          display_name: m.display_name as string,
          category: m.category as string,
          instrument_type: m.instrument_type as string,
          min_lot: Number(m.min_lot),
          max_lot: Number(m.max_lot),
          lot_step: Number(m.lot_step),
          lot_size: row ? Number(row.lot_size) : Number(m.min_lot),
          enabled: row ? Boolean(row.enabled) : false,
          trading_enabled: row ? Boolean(row.trading_enabled) : false,
          configured: Boolean(row),
          source: 'capital_com' as const,
        };
      });

      if (q.category && q.category !== 'all') {
        rows = rows.filter((r) => r.category === q.category);
      }
      if (q.q?.trim()) {
        const needle = q.q.trim().toLowerCase();
        rows = rows.filter(
          (r) =>
            r.epic.toLowerCase().includes(needle) ||
            r.display_name.toLowerCase().includes(needle) ||
            r.symbol.toLowerCase().includes(needle)
        );
      }
      return rows;
    }

    // Fallback only until Capital.com pull has been run.
    const catalog = getEnabledInstruments();
    return catalog.map((inst) => {
      const row = settingsById.get(inst.id);
      return {
        instrument_id: inst.id,
        epic: inst.symbol,
        symbol: inst.symbol,
        display_name: inst.display_name,
        category: inst.category,
        instrument_type: inst.category,
        min_lot: inst.min_lot,
        max_lot: inst.max_lot,
        lot_step: inst.lot_step,
        lot_size: row ? Number(row.lot_size) : inst.min_lot,
        enabled: row ? Boolean(row.enabled) : false,
        trading_enabled: row ? Boolean(row.trading_enabled) : false,
        configured: Boolean(row),
        source: 'local_fallback' as const,
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

    const link = await pool.query(
      'SELECT broker_connection_id FROM broker_accounts WHERE id = $1',
      [accountId]
    );
    if (link.rows.length === 0) {
      return reply.code(404).send({ error: 'Account not found' });
    }
    const connectionId = link.rows[0].broker_connection_id as number;

    const capital = await pool.query(
      'SELECT * FROM capital_markets WHERE broker_connection_id = $1 AND id = $2',
      [connectionId, instrumentId]
    );

    let symbol = `INST_${instrumentId}`;
    let minLot = 0.01;
    let maxLot = 100;
    let lotStep = 0.01;

    if (capital.rows.length > 0) {
      symbol = capital.rows[0].epic as string;
      minLot = Number(capital.rows[0].min_lot);
      maxLot = Number(capital.rows[0].max_lot);
      lotStep = Number(capital.rows[0].lot_step);
    } else {
      const inst = getInstrumentById(parseInt(instrumentId, 10));
      if (!inst) {
        return reply.code(404).send({ error: `Unknown instrument ${instrumentId}` });
      }
      symbol = inst.symbol;
      minLot = inst.min_lot;
      maxLot = inst.max_lot;
      lotStep = inst.lot_step;
    }

    let lot = body.lot_size;
    if (lot !== undefined) {
      if (lot < minLot || lot > maxLot) {
        return reply.code(400).send({
          error: `lot_size must be between ${minLot} and ${maxLot} for ${symbol}`,
        });
      }
      const steps = Math.round(lot / lotStep);
      lot = Number((steps * lotStep).toFixed(8));
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
        symbol,
        lot ?? prev.rows[0]?.lot_size ?? minLot,
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
