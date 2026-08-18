import { existsSync, readFileSync } from 'fs';
import { FastifyInstance } from 'fastify';
import { join } from 'path';
import { pool } from '../db/pool.js';
import { logAudit } from '../services/audit.js';
import { generateAccessCode, hashAccessCode } from '../security/accessCode.js';
import { revokeAllClientSessions } from '../security/clientSession.js';
import {
  getClientPanelStatus,
  stopClientRobot,
} from '../services/clientPanel.js';
import { getDeviceRegistry } from '../vs-core/network/deviceRegistry.js';
import { issueEnrollmentPackage } from '../vs-core/network/enrollment.js';
import { ensureServerIdentity } from '../vs-core/network/deviceLifecycle.js';
import { VS_WG_SERVER_IP } from '../vs-core/network/networkConstants.js';
import { applyClientDisplayName } from '../services/robotDesk.js';

function stablePublicClientUrl(): string | null {
  const file = process.env.VS_CLIENT_URL_FILE || '/etc/vs/client-url';
  try {
    if (existsSync(file)) {
      const line = readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && /https?:\/\//i.test(l));
      if (line) return line.replace(/\/$/, '') + '/';
    }
  } catch {
    /* ignore */
  }
  const env = String(process.env.VS_PUBLIC_CLIENT_URL || '').trim();
  if (env) return env.replace(/\/$/, '') + '/';
  return null;
}

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
    const body = request.body as { name?: string };
    const name = String(body.name || '').trim();
    if (!name) {
      return reply.code(400).send({ error: 'name required', message: 'Client login name required' });
    }
    const dup = await pool.query(
      `SELECT id FROM clients WHERE lower(name) = lower($1) LIMIT 1`,
      [name]
    );
    if (dup.rows.length) {
      return reply.code(409).send({
        error: 'name_taken',
        message: 'Client login name already exists',
      });
    }
    const { rows } = await pool.query(
      'INSERT INTO clients (name) VALUES ($1) RETURNING id, name, enabled, access_enabled, created_at',
      [name]
    );
    await logAudit('admin', 'client_created', 'client', String(rows[0].id), null, rows[0]);
    return rows[0];
  });

  /** Create client + web password + remote WireGuard enrollment (outside home Wi‑Fi). */
  app.post('/api/clients/provision-web', async (request, reply) => {
    const body = (request.body || {}) as { name?: string };
    const name = String(body.name || '').trim();
    if (!name) {
      return reply.code(400).send({ error: 'name required', message: 'Client login name required' });
    }
    const dup = await pool.query(
      `SELECT id FROM clients WHERE lower(name) = lower($1) LIMIT 1`,
      [name]
    );
    if (dup.rows.length) {
      return reply.code(409).send({
        error: 'name_taken',
        message: 'Client login name already exists',
      });
    }
    const { rows } = await pool.query(
      'INSERT INTO clients (name) VALUES ($1) RETURNING id, name, enabled, access_enabled, created_at',
      [name]
    );
    const clientId = rows[0].id as number;
    const code = generateAccessCode();
    const hash = hashAccessCode(code);
    await pool.query(
      `UPDATE clients SET access_code_hash = $2, access_enabled = true, updated_at = NOW() WHERE id = $1`,
      [clientId, hash]
    );

    const publicUrl = stablePublicClientUrl();
    const lanHost =
      process.env.VS_LAN_URL ||
      (process.env.VS_SERVER_LAN_IP
        ? `http://${process.env.VS_SERVER_LAN_IP}:${process.env.CONTROL_API_PORT || 3000}`
        : `http://127.0.0.1:${process.env.CONTROL_API_PORT || 3000}`);
    const panel_url_lan = lanHost.replace(/\/$/, '') + '/';
    const panel_url_vpn = `http://${VS_WG_SERVER_IP}:${process.env.CONTROL_API_PORT || 3000}/`;
    const panel_url = publicUrl || panel_url_vpn;

    let wireguard: Record<string, unknown> | null = null;
    let wg_warning: string | null = null;
    try {
      const root =
        process.env.VS_SERVER_DATA ||
        process.env.VS_CORE_DATA ||
        join(process.cwd(), 'data');
      const reg = getDeviceRegistry(root);
      ensureServerIdentity(reg, root);
      const pkg = issueEnrollmentPackage(reg, {
        device_type: 'CLIENT',
        client_id: clientId,
        created_by: 'admin-provision-web',
      });
      const endpointHost =
        pkg.server_endpoint_hostname ||
        process.env.VS_SERVER_ENDPOINT_HOSTNAME ||
        process.env.PUBLIC_HOST_OR_IP ||
        null;
      wireguard = {
        required_for_remote: true,
        enrollment_code: pkg.enrollment_code,
        enrollment_id: pkg.enrollment_id,
        device_id: pkg.device_id,
        expires_at: pkg.expires_at,
        server_endpoint_hostname: endpointHost,
        wg_listen_port: pkg.wg_listen_port,
        vpn_panel_url: panel_url_vpn,
        steps: [
          'On customer PC: install WireGuard',
          'Complete enrollment with enrollment_code (CLIENT/windows/INSTALL_CLIENT.bat or Connection Manager)',
          `Open VPN panel URL: ${panel_url_vpn}`,
          'Sign in with login + password from this screen',
          'Select market, set lot size, START/STOP robot',
        ],
        note: endpointHost
          ? `Router must forward UDP ${pkg.wg_listen_port} → i3. Endpoint: ${endpointHost}:${pkg.wg_listen_port}`
          : `Set PUBLIC_HOST_OR_IP / VS_SERVER_ENDPOINT_HOSTNAME on i3 and forward UDP ${pkg.wg_listen_port}. Without public endpoint, remote WireGuard is BLOCKED (CGNAT/home ISP).`,
      };
    } catch (err) {
      wg_warning = err instanceof Error ? err.message : 'WireGuard enrollment failed';
    }

    await logAudit('admin', 'client_provision_web', 'client', String(clientId), null, {
      name,
      access_enabled: true,
      wireguard: Boolean(wireguard),
    });

    return {
      success: true,
      client_id: clientId,
      login: name,
      password: code,
      panel_url,
      panel_url_public: publicUrl,
      panel_url_vpn,
      panel_url_lan,
      wireguard,
      wg_warning,
      message: publicUrl
        ? 'Save login + password now (password shown once). Client opens the public HTTPS URL — it does not change on VS update.'
        : 'Save login + password now. Set /etc/vs/client-url to a stable https://host so clients never see :3000.',
    };
  });

  app.put('/api/clients/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      enabled?: boolean;
      access_enabled?: boolean;
      preferred_broker_account_id?: number | null;
    };
    const prev = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (!prev.rows.length) return reply.code(404).send({ error: 'Not found' });

    let nextName: string | null = null;
    if (body.name != null) {
      nextName = String(body.name).trim();
      if (!nextName) {
        return reply.code(400).send({ error: 'name required', message: 'Client name required' });
      }
      const dup = await pool.query(
        `SELECT id FROM clients WHERE lower(name) = lower($1) AND id <> $2 LIMIT 1`,
        [nextName, id]
      );
      if (dup.rows.length) {
        return reply.code(409).send({
          error: 'name_taken',
          message: 'Client login name already exists',
        });
      }
    }

    await pool.query(
      `UPDATE clients SET
        name = COALESCE($2, name),
        enabled = COALESCE($3, enabled),
        access_enabled = COALESCE($4, access_enabled),
        updated_at = NOW()
       WHERE id = $1`,
      [id, nextName, body.enabled ?? null, body.access_enabled ?? null]
    );
    if (body.preferred_broker_account_id !== undefined) {
      await pool.query(
        `UPDATE clients SET preferred_broker_account_id = $2, updated_at = NOW() WHERE id = $1`,
        [id, body.preferred_broker_account_id]
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
    if (nextName) applyClientDisplayName(Number(id), nextName);
    return fresh.rows[0];
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
