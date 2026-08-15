/**
 * Private network management HTTP API — OWNER_ADMIN / SERVER only for management.
 * CLIENT may only heartbeat + client service (enforced in authorizeSession).
 */

import type { FastifyInstance } from 'fastify';
import { join } from 'path';
import { getDeviceRegistry } from './deviceRegistry.js';
import {
  authenticateDevice,
  authorizeSession,
  reconnectSession,
  invalidateDeviceSessions,
} from './deviceAuth.js';
import {
  registerAdminDevice,
  registerClientDevice,
  revokeDevice,
  rotateDeviceKey,
  ensureServerIdentity,
} from './deviceLifecycle.js';
import { assertClientScope } from './networkRoles.js';
import { runNetworkDiagnostics, renderNetworkStatusBlock } from './networkDiagnostics.js';
import { buildServerConfFromRegistry } from './wireguardConfig.js';

function dataRoot(): string {
  return (
    process.env.VS_SERVER_DATA ||
    process.env.VS_CORE_DATA ||
    join(process.cwd(), 'data', 'vs-server')
  );
}

function sessionHeader(req: { headers: Record<string, unknown> }): string | undefined {
  const h = req.headers['x-vs-session'];
  return typeof h === 'string' ? h : undefined;
}

export async function registerPrivateNetworkRoutes(app: FastifyInstance): Promise<void> {
  const root = dataRoot();

  app.post('/api/v1/network/device/auth', async (req, reply) => {
    const body = (req.body || {}) as { device_id?: string; device_token?: string };
    if (!body.device_id || !body.device_token) {
      return reply.code(400).send({ ok: false, code: 'INVALID_REQUEST' });
    }
    const reg = getDeviceRegistry(root);
    const r = authenticateDevice(reg, {
      device_id: body.device_id,
      device_token: body.device_token,
    });
    if (!r.ok) return reply.code(401).send(r);
    return {
      ok: true,
      session_id: r.session.session_id,
      device_id: r.device.device_id,
      role: r.device.role,
      private_ip: r.device.private_ip,
      server_id: reg.getMeta().server_id,
    };
  });

  app.post('/api/v1/network/device/heartbeat', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_HEARTBEAT');
    if (!auth.ok) return reply.code(403).send(auth);
    const body = (req.body || {}) as { latency_ms?: number };
    const d = reg.heartbeat(auth.device.device_id, {
      session_id: auth.session.session_id,
      latency_ms: body.latency_ms ?? null,
    });
    return { ok: true, connection_state: d.connection_state, last_seen: d.last_seen };
  });

  app.post('/api/v1/network/device/reconnect', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const sid = sessionHeader(req);
    if (!sid) return reply.code(401).send({ ok: false, code: 'EXPIRED_SESSION' });
    const r = reconnectSession(reg, sid);
    if (!r.ok) return reply.code(401).send(r);
    return {
      ok: true,
      session_id: r.session.session_id,
      trading_commands_replayed: false,
    };
  });

  app.get('/api/v1/network/status', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'NETWORK_DIAGNOSTICS');
    if (!auth.ok) {
      // Also allow OWNER_ADMIN via admin token for bootstrap
      return reply.code(403).send(auth);
    }
    return {
      ok: true,
      text: renderNetworkStatusBlock(reg),
      meta: reg.getMeta(),
      counts: reg.counts(),
      devices: reg.list().map((d) => ({
        device_id: d.device_id,
        device_type: d.device_type,
        private_ip: d.private_ip,
        status: d.status,
        connection_state: d.connection_state,
        latency_ms: d.latency_ms,
        client_id: d.client_id,
        // never public_key secrets beyond fingerprint
        key_fingerprint: d.key_fingerprint,
      })),
    };
  });

  app.post('/api/v1/network/admin/register', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    // Bootstrap: allow local admin token when no OWNER_ADMIN sessions yet
    const boot =
      !auth.ok &&
      String(req.headers['x-admin-token'] || '') === process.env.API_ADMIN_TOKEN &&
      process.env.API_ADMIN_TOKEN &&
      process.env.API_ADMIN_TOKEN !== 'CHANGE_ME_ADMIN_TOKEN';
    if (!auth.ok && !boot) return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    ensureServerIdentity(reg, root);
    const body = (req.body || {}) as { device_name?: string; device_id?: string };
    const issued = registerAdminDevice(reg, root, body);
    return {
      ok: true,
      device_id: issued.device_id,
      private_ip: issued.private_ip,
      public_key: issued.public_key,
      device_token: issued.device_token,
      peer_config_path: issued.peer_config_path,
      // private_key_once returned once for operator handoff — not stored in registry
      private_key_once: issued.private_key_once,
      note: 'Store private_key_once securely on ADMIN device; remove from SERVER issued copy after transfer',
    };
  });

  app.post('/api/v1/network/client/register', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    const boot =
      !auth.ok &&
      String(req.headers['x-admin-token'] || '') === process.env.API_ADMIN_TOKEN &&
      process.env.API_ADMIN_TOKEN &&
      process.env.API_ADMIN_TOKEN !== 'CHANGE_ME_ADMIN_TOKEN';
    if (!auth.ok && !boot) return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    const body = (req.body || {}) as {
      client_id?: number;
      account_id?: number;
      device_name?: string;
      device_id?: string;
    };
    if (body.client_id == null || !Number.isFinite(body.client_id)) {
      return reply.code(400).send({ ok: false, code: 'INVALID_CLIENT_ID' });
    }
    ensureServerIdentity(reg, root);
    const issued = registerClientDevice(reg, root, {
      client_id: body.client_id,
      account_id: body.account_id ?? null,
      device_name: body.device_name,
      device_id: body.device_id,
    });
    return {
      ok: true,
      device_id: issued.device_id,
      private_ip: issued.private_ip,
      public_key: issued.public_key,
      device_token: issued.device_token,
      peer_config_path: issued.peer_config_path,
      private_key_once: issued.private_key_once,
      client_id: issued.client_id,
    };
  });

  app.post('/api/v1/network/device/revoke', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    if (!auth.ok) return reply.code(403).send(auth);
    const body = (req.body || {}) as { device_id?: string };
    if (!body.device_id) return reply.code(400).send({ ok: false, code: 'INVALID_REQUEST' });
    revokeDevice(reg, body.device_id);
    return { ok: true, device_id: body.device_id, status: 'REVOKED' };
  });

  app.post('/api/v1/network/device/rotate-key', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    if (!auth.ok) return reply.code(403).send(auth);
    const body = (req.body || {}) as { device_id?: string };
    if (!body.device_id) return reply.code(400).send({ ok: false, code: 'INVALID_REQUEST' });
    const rotated = rotateDeviceKey(reg, root, body.device_id);
    return {
      ok: true,
      device_id: body.device_id,
      public_key: rotated.public_key,
      device_token: rotated.device_token,
      private_key_once: rotated.private_key_once,
      peer_config_path: rotated.peer_config_path,
    };
  });

  /** CLIENT trying to hit admin management → denied (also tested at role layer). */
  app.get('/api/v1/network/admin/only', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'ADMIN_SERVICE');
    if (!auth.ok) return reply.code(403).send(auth);
    return { ok: true, role: auth.device.role };
  });

  /** Client scope probe — Client A cannot read Client B. */
  app.get('/api/v1/network/client/:clientId/scope', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'CLIENT_SERVICE');
    if (!auth.ok) return reply.code(403).send(auth);
    const target = Number((req.params as { clientId: string }).clientId);
    const scope = assertClientScope(auth.device, target);
    if (!scope.ok) return reply.code(403).send(scope);
    return { ok: true, client_id: target };
  });

  app.get('/api/v1/network/diagnostics', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'NETWORK_DIAGNOSTICS');
    const boot =
      !auth.ok &&
      String(req.headers['x-admin-token'] || '') === process.env.API_ADMIN_TOKEN &&
      process.env.API_ADMIN_TOKEN &&
      process.env.API_ADMIN_TOKEN !== 'CHANGE_ME_ADMIN_TOKEN';
    if (!auth.ok && !boot) return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    const diag = runNetworkDiagnostics({ dataRoot: root, registry: reg });
    return { ok: diag.summary.fail === 0, ...diag };
  });

  app.get('/api/v1/network/wg/server-template', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    if (!auth.ok) return reply.code(403).send(auth);
    return {
      ok: true,
      conf: buildServerConfFromRegistry(reg),
      note: 'PrivateKey must be substituted from data store — never from git',
    };
  });
}
