import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { logAudit } from '../services/audit.js';
import { generateAccessCode, hashAccessCode } from '../security/accessCode.js';
import { revokeAllClientSessions } from '../security/clientSession.js';
import {
  getClientPanelStatus,
  stopClientRobot,
} from '../services/clientPanel.js';

async function hardDeleteClient(clientId: string): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('DELETE FROM client_sessions WHERE client_id = $1', [clientId]);
    await db.query('DELETE FROM client_login_attempts WHERE 1=0'); // keep attempts global
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

async function assertBrokerAccountEnabled(accountId: number): Promise<{
  account_id: number;
  connection_id: number;
  display_name: string;
  broker_name: string;
  environment: string;
}> {
  const { rows } = await pool.query(
    `SELECT ba.id as account_id, ba.display_name, bc.id as connection_id,
            bc.broker_name, bc.environment
     FROM broker_accounts ba
     JOIN broker_connections bc ON bc.id = ba.broker_connection_id
     WHERE ba.id = $1 AND ba.enabled = true AND bc.enabled = true`,
    [accountId]
  );
  if (!rows.length) {
    throw new Error(`Broker account #${accountId} not found or disabled`);
  }
  return {
    account_id: Number(rows[0].account_id),
    connection_id: Number(rows[0].connection_id),
    display_name: String(rows[0].display_name || `#${accountId}`),
    broker_name: String(rows[0].broker_name),
    environment: String(rows[0].environment),
  };
}

async function resolveMarketOnConnection(
  connectionId: number,
  epic: string
): Promise<{ epic: string; display_name: string; min_lot: number; max_lot: number; lot_step: number }> {
  const { rows } = await pool.query(
    `SELECT epic, display_name, min_lot, max_lot, lot_step
     FROM capital_markets
     WHERE broker_connection_id = $1 AND epic = $2`,
    [connectionId, epic]
  );
  if (!rows.length) {
    throw new Error(`Market ${epic} not found on this broker — pull markets first`);
  }
  return {
    epic: String(rows[0].epic),
    display_name: String(rows[0].display_name || rows[0].epic),
    min_lot: Number(rows[0].min_lot),
    max_lot: Number(rows[0].max_lot),
    lot_step: Number(rows[0].lot_step),
  };
}

export async function registerClientRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/clients', async () => {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.enabled, c.access_enabled,
              c.access_code_hash IS NOT NULL as has_access_code,
              c.preferred_broker_account_id,
              c.panel_epic, c.panel_display_name, c.panel_lot_size,
              c.panel_robot_requested, c.last_seen_at,
              c.created_at, c.updated_at
       FROM clients c
       ORDER BY c.created_at DESC`
    );

    const out = [];
    for (const row of rows) {
      let panel = null;
      try {
        panel = await getClientPanelStatus(row.id as number);
      } catch {
        panel = null;
      }
      out.push({
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        access_enabled: row.access_enabled,
        has_access_code: row.has_access_code,
        preferred_broker_account_id: row.preferred_broker_account_id,
        panel_epic: row.panel_epic,
        panel_display_name: row.panel_display_name,
        panel_lot_size: row.panel_lot_size != null ? Number(row.panel_lot_size) : null,
        panel_robot_requested: row.panel_robot_requested,
        last_seen_at: row.last_seen_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        robot_status: panel?.robot_status ?? 'STOPPED',
        live_trade: panel?.live_trade ?? null,
        account_id: panel?.account_id ?? null,
      });
    }
    return out;
  });

  app.get('/api/clients/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await pool.query(
      `SELECT id, name, enabled, access_enabled,
              access_code_hash IS NOT NULL as has_access_code,
              preferred_broker_account_id,
              panel_epic, panel_display_name, panel_lot_size,
              panel_robot_requested, last_seen_at, created_at, updated_at
       FROM clients WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return { error: 'Not found' };
    const accounts = await pool.query(
      `SELECT ba.*, bc.broker_name, bc.environment
       FROM broker_accounts ba
       JOIN broker_connections bc ON bc.id = ba.broker_connection_id
       WHERE bc.client_id = $1`,
      [id]
    );
    let panel = null;
    try {
      panel = await getClientPanelStatus(Number(id));
    } catch {
      panel = null;
    }
    return { ...rows[0], accounts: accounts.rows, panel };
  });

  app.post('/api/clients', async (request, reply) => {
    try {
      const body = request.body as {
        name: string;
        preferred_broker_account_id?: number | null;
        panel_epic?: string | null;
        panel_display_name?: string | null;
        panel_lot_size?: number | null;
      };
      if (!body.name?.trim()) {
        return reply.code(400).send({ error: 'name is required' });
      }

      let preferred: number | null =
        body.preferred_broker_account_id === undefined || body.preferred_broker_account_id === null
          ? null
          : Number(body.preferred_broker_account_id);
      let panelEpic: string | null = body.panel_epic?.trim() || null;
      let panelDisplay: string | null = body.panel_display_name?.trim() || null;
      let panelLot: number | null =
        body.panel_lot_size === undefined || body.panel_lot_size === null
          ? null
          : Number(body.panel_lot_size);

      if (preferred != null) {
        if (!Number.isFinite(preferred) || preferred <= 0) {
          return reply.code(400).send({ error: 'Invalid preferred_broker_account_id' });
        }
        const account = await assertBrokerAccountEnabled(preferred);
        if (panelEpic) {
          const market = await resolveMarketOnConnection(account.connection_id, panelEpic);
          panelDisplay = panelDisplay || market.display_name;
          if (panelLot == null) panelLot = market.min_lot;
          if (panelLot < market.min_lot || panelLot > market.max_lot) {
            return reply.code(400).send({
              error: `lot_size must be between ${market.min_lot} and ${market.max_lot}`,
            });
          }
        }
      } else if (panelEpic) {
        return reply.code(400).send({
          error: 'Select a broker account before choosing a market',
        });
      }

      const { rows } = await pool.query(
        `INSERT INTO clients (
           name, preferred_broker_account_id, panel_epic, panel_display_name, panel_lot_size
         ) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, enabled, access_enabled, preferred_broker_account_id,
                   panel_epic, panel_display_name, panel_lot_size, created_at`,
        [body.name.trim(), preferred, panelEpic, panelDisplay, panelLot]
      );
      await logAudit('admin', 'client_created', 'client', String(rows[0].id), null, rows[0]);
      return rows[0];
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create client';
      return reply.code(400).send({ error: message, message });
    }
  });

  app.put('/api/clients/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        enabled?: boolean;
        access_enabled?: boolean;
        preferred_broker_account_id?: number | null;
        panel_epic?: string | null;
        panel_display_name?: string | null;
        panel_lot_size?: number | null;
      };
      const prev = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
      if (!prev.rows.length) return reply.code(404).send({ error: 'Not found' });

      await pool.query(
        `UPDATE clients SET
          name = COALESCE($2, name),
          enabled = COALESCE($3, enabled),
          access_enabled = COALESCE($4, access_enabled),
          updated_at = NOW()
         WHERE id = $1`,
        [id, body.name ?? null, body.enabled ?? null, body.access_enabled ?? null]
      );

      if (body.preferred_broker_account_id !== undefined) {
        const preferred =
          body.preferred_broker_account_id === null
            ? null
            : Number(body.preferred_broker_account_id);
        if (preferred != null) {
          if (!Number.isFinite(preferred) || preferred <= 0) {
            return reply.code(400).send({ error: 'Invalid preferred_broker_account_id' });
          }
          await assertBrokerAccountEnabled(preferred);
        }
        await pool.query(
          `UPDATE clients SET preferred_broker_account_id = $2, updated_at = NOW() WHERE id = $1`,
          [id, preferred]
        );
      }

      if (
        body.panel_epic !== undefined ||
        body.panel_display_name !== undefined ||
        body.panel_lot_size !== undefined
      ) {
        const freshPref = await pool.query(
          `SELECT preferred_broker_account_id, panel_epic, panel_display_name, panel_lot_size
           FROM clients WHERE id = $1`,
          [id]
        );
        const cur = freshPref.rows[0] as {
          preferred_broker_account_id: number | null;
          panel_epic: string | null;
          panel_display_name: string | null;
          panel_lot_size: string | number | null;
        };
        let panelEpic =
          body.panel_epic !== undefined
            ? body.panel_epic?.trim() || null
            : cur.panel_epic;
        let panelDisplay =
          body.panel_display_name !== undefined
            ? body.panel_display_name?.trim() || null
            : cur.panel_display_name;
        let panelLot =
          body.panel_lot_size !== undefined
            ? body.panel_lot_size === null
              ? null
              : Number(body.panel_lot_size)
            : cur.panel_lot_size == null
              ? null
              : Number(cur.panel_lot_size);

        if (panelEpic) {
          if (!cur.preferred_broker_account_id) {
            return reply.code(400).send({
              error: 'Select a broker account before choosing a market',
            });
          }
          const account = await assertBrokerAccountEnabled(cur.preferred_broker_account_id);
          const market = await resolveMarketOnConnection(account.connection_id, panelEpic);
          panelDisplay = panelDisplay || market.display_name;
          if (panelLot == null) panelLot = market.min_lot;
          if (panelLot < market.min_lot || panelLot > market.max_lot) {
            return reply.code(400).send({
              error: `lot_size must be between ${market.min_lot} and ${market.max_lot}`,
            });
          }
        } else {
          panelDisplay = null;
          panelLot = null;
        }

        await pool.query(
          `UPDATE clients SET
             panel_epic = $2,
             panel_display_name = $3,
             panel_lot_size = $4,
             updated_at = NOW()
           WHERE id = $1`,
          [id, panelEpic, panelDisplay, panelLot]
        );
      }

      const fresh = await pool.query(
        `SELECT id, name, enabled, access_enabled, preferred_broker_account_id,
                access_code_hash IS NOT NULL as has_access_code,
                panel_epic, panel_display_name, panel_lot_size, last_seen_at
         FROM clients WHERE id = $1`,
        [id]
      );
      await logAudit('admin', 'client_updated', 'client', id, prev.rows[0], fresh.rows[0]);
      return fresh.rows[0];
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update client';
      return reply.code(400).send({ error: message, message });
    }
  });

  app.post('/api/clients/:id/access-code', async (request, reply) => {
    const { id } = request.params as { id: string };
    const exists = await pool.query('SELECT id, name FROM clients WHERE id = $1', [id]);
    if (!exists.rows.length) {
      return reply.code(404).send({ error: 'Client not found' });
    }
    const code = generateAccessCode();
    const hash = hashAccessCode(code);
    await pool.query(
      `UPDATE clients SET
         access_code_hash = $2,
         access_enabled = true,
         updated_at = NOW()
       WHERE id = $1`,
      [id, hash]
    );
    await revokeAllClientSessions(Number(id));
    await logAudit('admin', 'client_access_code_reset', 'client', id, null, {
      access_enabled: true,
    });
    // Plaintext returned ONCE — never stored
    return {
      success: true,
      client_id: Number(id),
      access_code: code,
      access_enabled: true,
      message: 'Save this access code now — it will not be shown again.',
    };
  });

  app.post('/api/clients/:id/revoke-access', async (request, reply) => {
    const { id } = request.params as { id: string };
    const exists = await pool.query('SELECT id FROM clients WHERE id = $1', [id]);
    if (!exists.rows.length) {
      return reply.code(404).send({ error: 'Client not found' });
    }
    await pool.query(
      `UPDATE clients SET access_enabled = false, updated_at = NOW() WHERE id = $1`,
      [id]
    );
    await revokeAllClientSessions(Number(id));
    try {
      await stopClientRobot(Number(id));
    } catch {
      /* no robot */
    }
    await logAudit('admin', 'client_access_revoked', 'client', id, null, {
      access_enabled: false,
    });
    return { success: true };
  });

  app.post('/api/clients/:id/stop-robot', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const status = await stopClientRobot(Number(id));
      await logAudit('admin', 'client_robot_stopped', 'client', id, null, status);
      return { success: true, status };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stop failed';
      return reply.code(400).send({ error: message, message });
    }
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
      'UPDATE clients SET enabled = false, access_enabled = false, updated_at = NOW() WHERE id = $1',
      [id]
    );
    await revokeAllClientSessions(Number(id));
    await logAudit('admin', 'client_disabled', 'client', id, prev.rows[0], { enabled: false });
    return { success: true, hard: false };
  });
}
