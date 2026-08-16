/**
 * Production Network Authority API.
 * Admin: devices, enrollment, revoke, rotate, health.
 * Client: own device/session only.
 */

import type { FastifyInstance } from 'fastify';
import { join } from 'path';
import { getDeviceRegistry } from './deviceRegistry.js';
import {
  authenticateDevice,
  authorizeSession,
  reconnectSession,
} from './deviceAuth.js';
import {
  registerAdminDevice,
  registerClientDevice,
  revokeDevice,
  rotateDeviceKey,
  rotateDevicePublicKeyOnServer,
  ensureServerIdentity,
} from './deviceLifecycle.js';
import {
  issueEnrollmentPackage,
  completeEnrollment,
  revokeEnrollmentPackage,
  replaceLostDevice,
} from './enrollment.js';
import { assertClientScope } from './networkRoles.js';
import { assertPermission, hasPermission } from './permissions.js';
import { runNetworkDiagnostics, renderNetworkStatusBlock } from './networkDiagnostics.js';
import { buildServerConfFromRegistry, serverWgEndpoint } from './wireguardConfig.js';
import { executeIdempotent } from './commandIdempotency.js';
import { appendNetworkAudit } from './networkAudit.js';
import { raiseNetworkIncident } from './networkIncidents.js';
import { generateWgKeyPair } from './wireguardKeys.js';
import { VS_INTERNAL_SERVICES } from './networkConstants.js';

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

function bootAdmin(req: { headers: Record<string, unknown> }): boolean {
  return (
    String(req.headers['x-admin-token'] || '') === process.env.API_ADMIN_TOKEN &&
    !!process.env.API_ADMIN_TOKEN &&
    process.env.API_ADMIN_TOKEN !== 'CHANGE_ME_ADMIN_TOKEN'
  );
}

export async function registerPrivateNetworkRoutes(app: FastifyInstance): Promise<void> {
  const root = dataRoot();

  /** Service catalog — Connection Manager resolves; users never type ports. */
  app.get('/api/v1/network/catalog', async (_req, reply) => {
    return {
      ok: true,
      server_id: getDeviceRegistry(root).getMeta().server_id,
      services: VS_INTERNAL_SERVICES,
      note: 'Internal implementation detail — Connection Manager consumes this, not end-user UI',
    };
  });

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
    if (!r.ok) {
      appendNetworkAudit(root, {
        action: 'AUTH_FAILED',
        actor: body.device_id,
        device_id: body.device_id,
        result: 'DENIED',
        detail: { code: r.code },
      });
      if (r.code === 'INVALID_KEY' || r.code === 'UNKNOWN_DEVICE') {
        raiseNetworkIncident({
          code: 'DEVICE_AUTH_FAILURE',
          reason: r.code,
          severity: 'WARNING',
        });
      }
      return reply.code(401).send(r);
    }
    appendNetworkAudit(root, {
      action: 'LOGIN',
      actor: r.device.device_id,
      device_id: r.device.device_id,
      result: 'OK',
    });
    return {
      ok: true,
      session_id: r.session.session_id,
      device_id: r.device.device_id,
      role: r.device.role,
      private_address: r.device.private_address,
      private_ip: r.device.private_address,
      server_id: reg.getMeta().server_id,
      permissions: r.device.permissions,
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
    if (!auth.ok && !bootAdmin(req)) {
      return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    }
    return {
      ok: true,
      text: renderNetworkStatusBlock(reg),
      meta: reg.getMeta(),
      counts: reg.counts(),
      devices: reg.list().map((d) => ({
        device_id: d.device_id,
        device_type: d.device_type,
        private_address: d.private_address,
        status: d.status,
        connection_state: d.connection_state,
        latency_ms: d.latency_ms,
        client_id: d.client_id,
        key_fingerprint: d.key_fingerprint,
        key_version: d.key_version,
        last_seen: d.last_seen ?? d.connected_at ?? null,
      })),
    };
  });

  // ── Enrollment ─────────────────────────────────────────────

  app.post('/api/v1/network/enrollment/create', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    if (!auth.ok && !bootAdmin(req)) {
      return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    }
    ensureServerIdentity(reg, root);
    const body = (req.body || {}) as {
      device_type?: 'ADMIN' | 'CLIENT';
      device_id?: string;
      client_id?: number;
      account_id?: number;
      ttl_ms?: number;
    };
    if (body.device_type !== 'ADMIN' && body.device_type !== 'CLIENT') {
      return reply.code(400).send({ ok: false, code: 'INVALID_DEVICE_TYPE' });
    }
    try {
      const pkg = issueEnrollmentPackage(reg, {
        device_type: body.device_type,
        device_id: body.device_id,
        client_id: body.client_id,
        account_id: body.account_id,
        ttl_ms: body.ttl_ms,
        created_by: auth.ok ? auth.device.device_id : 'BOOTSTRAP_ADMIN',
      });
      appendNetworkAudit(root, {
        action: 'ENROLLMENT_CREATED',
        actor: auth.ok ? auth.device.device_id : 'BOOTSTRAP',
        device_id: pkg.device_id,
        result: 'OK',
        detail: { enrollment_id: pkg.enrollment_id, device_type: pkg.device_type },
      });
      return { ok: true, ...pkg };
    } catch (e) {
      return reply.code(400).send({
        ok: false,
        code: e instanceof Error ? e.message : 'ENROLLMENT_FAILED',
      });
    }
  });

  app.post('/api/v1/network/enrollment/complete', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const body = (req.body || {}) as {
      enrollment_code?: string;
      public_key?: string;
      device_name?: string;
      /** If true, SERVER generates keypair (bootstrap only — product prefers device-local keys) */
      generate_on_server?: boolean;
    };
    if (!body.enrollment_code) {
      return reply.code(400).send({ ok: false, code: 'INVALID_REQUEST' });
    }
    let public_key = body.public_key;
    let private_key_once: string | undefined;
    if (!public_key && body.generate_on_server) {
      const pair = generateWgKeyPair();
      public_key = pair.publicKey;
      private_key_once = pair.privateKey;
    }
    if (!public_key) {
      return reply.code(400).send({
        ok: false,
        code: 'PUBLIC_KEY_REQUIRED',
        reason: 'Generate key on device and submit public_key',
      });
    }
    try {
      const done = completeEnrollment(reg, {
        enrollment_code: body.enrollment_code,
        public_key,
        device_name: body.device_name,
      });
      appendNetworkAudit(root, {
        action: 'ENROLLMENT_COMPLETED',
        actor: done.device_id,
        device_id: done.device_id,
        result: 'OK',
      });
      const meta = reg.getMeta();
      return {
        ok: true,
        ...done,
        wg_endpoint: serverWgEndpoint(meta.server_endpoint_hostname, meta.wg_listen_port),
        private_key_once,
        connection: {
          server_id: done.server_id,
          note: 'Use Connection Manager with server_id — do not configure ports in UI',
        },
      };
    } catch (e) {
      const code = e instanceof Error ? e.message : 'ENROLLMENT_FAILED';
      return reply.code(400).send({ ok: false, code });
    }
  });

  app.post('/api/v1/network/enrollment/revoke', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    if (!auth.ok && !bootAdmin(req)) {
      return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    }
    const body = (req.body || {}) as { enrollment_id?: string };
    if (!body.enrollment_id) return reply.code(400).send({ ok: false, code: 'INVALID_REQUEST' });
    revokeEnrollmentPackage(reg, body.enrollment_id);
    appendNetworkAudit(root, {
      action: 'ENROLLMENT_REVOKED',
      actor: auth.ok ? auth.device.device_id : 'BOOTSTRAP_ADMIN',
      result: 'OK',
      detail: { enrollment_id: body.enrollment_id },
    });
    return { ok: true };
  });

  /** Pending / recent enrollments — MSI Control Panel (admin token or device session). */
  app.get('/api/v1/network/enrollments', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    if (!auth.ok && !bootAdmin(req)) {
      return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    }
    return {
      ok: true,
      enrollments: reg.listEnrollments().map((e) => {
        let status = 'PENDING';
        if (e.revoked_at) status = 'REVOKED';
        else if (e.used_at) status = 'USED';
        else if (Date.parse(e.expires_at) < Date.now()) status = 'EXPIRED';
        return {
          enrollment_id: e.enrollment_id,
          device_type: e.device_type,
          device_id: e.device_id,
          status,
          expires_at: e.expires_at,
          client_id: e.client_id,
          created_by: e.created_by,
          // Never return enrollment_code / token hash material
        };
      }),
    };
  });

  // Legacy bootstrap register (still available for INSTALL assistants)
  app.post('/api/v1/network/admin/register', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    if (!auth.ok && !bootAdmin(req)) {
      return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    }
    ensureServerIdentity(reg, root);
    const body = (req.body || {}) as { device_name?: string; device_id?: string };
    const issued = registerAdminDevice(reg, root, body);
    return {
      ok: true,
      device_id: issued.device_id,
      private_address: issued.private_address,
      private_ip: issued.private_ip,
      public_key: issued.public_key,
      device_token: issued.device_token,
      peer_config_path: issued.peer_config_path,
      private_key_once: issued.private_key_once,
      note: 'Prefer enrollment/create + device-local keys in product path',
    };
  });

  app.post('/api/v1/network/client/register', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    if (!auth.ok && !bootAdmin(req)) {
      return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    }
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
      private_address: issued.private_address,
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
    if (!auth.ok && !bootAdmin(req)) {
      return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    }
    const body = (req.body || {}) as { device_id?: string };
    if (!body.device_id) return reply.code(400).send({ ok: false, code: 'INVALID_REQUEST' });
    revokeDevice(reg, body.device_id, root);
    return { ok: true, device_id: body.device_id, status: 'REVOKED' };
  });

  app.post('/api/v1/network/device/lost', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    if (!auth.ok && !bootAdmin(req)) {
      return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    }
    const body = (req.body || {}) as { device_id?: string };
    if (!body.device_id) return reply.code(400).send({ ok: false, code: 'INVALID_REQUEST' });
    const actor = auth.ok ? auth.device.device_id : 'BOOTSTRAP_ADMIN';
    const pkg = replaceLostDevice(reg, body.device_id, actor);
    return { ok: true, revoked: body.device_id, enrollment: pkg };
  });

  app.post('/api/v1/network/device/rotate-key', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    if (!auth.ok && !bootAdmin(req)) {
      return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    }
    const body = (req.body || {}) as { device_id?: string; public_key?: string };
    if (!body.device_id) return reply.code(400).send({ ok: false, code: 'INVALID_REQUEST' });
    if (body.public_key) {
      const rotated = rotateDevicePublicKeyOnServer(reg, root, body.device_id, body.public_key);
      return { ok: true, device_id: body.device_id, ...rotated };
    }
    const rotated = rotateDeviceKey(reg, root, body.device_id);
    return {
      ok: true,
      device_id: body.device_id,
      public_key: rotated.public_key,
      device_token: rotated.device_token,
      private_key_once: rotated.private_key_once,
      peer_config_path: rotated.peer_config_path,
      key_version: rotated.key_version,
    };
  });

  /** Idempotent state-changing command channel (START/STOP/lot/market/admin). */
  app.post('/api/v1/network/command', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'CLIENT_SERVICE');
    // Also allow OWNER_ADMIN
    const authAdmin = !auth.ok
      ? authorizeSession(reg, sessionHeader(req), 'ADMIN_SERVICE')
      : auth;
    if (!authAdmin.ok) return reply.code(403).send(authAdmin);
    const body = (req.body || {}) as {
      command_id?: string;
      kind?: string;
      client_id?: number;
      payload?: Record<string, unknown>;
    };
    if (!body.command_id || !body.kind) {
      return reply.code(400).send({ ok: false, code: 'INVALID_REQUEST' });
    }
    const device = authAdmin.device;
    // Isolation: client_id from identity, never trust body for CLIENT
    const effectiveClientId =
      device.role === 'CLIENT' ? device.client_id : body.client_id ?? null;
    if (device.role === 'CLIENT') {
      if (body.client_id != null && body.client_id !== device.client_id) {
        appendNetworkAudit(root, {
          action: 'PERMISSION_DENIED',
          actor: device.device_id,
          device_id: device.device_id,
          result: 'DENIED',
          detail: { reason: 'CLIENT_ISOLATION' },
        });
        return reply.code(403).send({ ok: false, code: 'CLIENT_ISOLATION' });
      }
      const need =
        body.kind === 'START'
          ? 'own.trading.start'
          : body.kind === 'STOP'
            ? 'own.trading.stop'
            : body.kind === 'LOT_CHANGE'
              ? 'own.lot.change'
              : body.kind === 'MARKET_CHANGE'
                ? 'own.market.change'
                : null;
      if (need && !hasPermission(device.role, need as 'own.trading.start', device.permissions)) {
        return reply.code(403).send({ ok: false, code: 'PERMISSION_DENIED' });
      }
    } else {
      const perm = assertPermission(device, 'trading.manage');
      if (body.kind === 'ADMIN_ACTION') {
        const p = assertPermission(device, 'server.manage');
        if (!p.ok) return reply.code(403).send(p);
      } else if (!perm.ok && body.kind !== 'ADMIN_ACTION') {
        // OWNER_ADMIN may still manage trading
        if (!hasPermission(device.role, 'trading.manage', device.permissions)) {
          return reply.code(403).send({ ok: false, code: 'PERMISSION_DENIED' });
        }
      }
    }

    const result = executeIdempotent(reg, {
      command_id: body.command_id,
      device_id: device.device_id,
      kind: body.kind,
      execute: () => ({
        accepted: true,
        kind: body.kind,
        client_id: effectiveClientId,
        at: new Date().toISOString(),
        // Network layer acknowledges only — does not execute Strategy/money path here
        executed_by: 'NETWORK_AUTHORITY_ACK',
      }),
    });
    if (!result.ok) return reply.code(400).send(result);
    appendNetworkAudit(root, {
      action: result.duplicate ? 'COMMAND_DUPLICATE' : 'COMMAND_EXECUTED',
      actor: device.device_id,
      device_id: device.device_id,
      result: 'OK',
      detail: { kind: body.kind, command_id: body.command_id, duplicate: result.duplicate },
    });
    return { ok: true, duplicate: result.duplicate, result: result.result };
  });

  app.get('/api/v1/network/admin/only', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'ADMIN_SERVICE');
    if (!auth.ok) return reply.code(403).send(auth);
    return { ok: true, role: auth.device.role };
  });

  app.get('/api/v1/network/client/:clientId/scope', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'CLIENT_SERVICE');
    if (!auth.ok) return reply.code(403).send(auth);
    const target = Number((req.params as { clientId: string }).clientId);
    const scope = assertClientScope(auth.device, target);
    if (!scope.ok) return reply.code(403).send(scope);
    return { ok: true, client_id: target };
  });

  /** Client own device info only. */
  app.get('/api/v1/network/me', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_HEARTBEAT');
    if (!auth.ok) return reply.code(403).send(auth);
    const d = auth.device;
    return {
      ok: true,
      device_id: d.device_id,
      role: d.role,
      private_address: d.private_address,
      client_id: d.client_id,
      connection_state: d.connection_state,
      key_version: d.key_version,
      permissions: d.permissions,
    };
  });

  app.get('/api/v1/network/diagnostics', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'NETWORK_DIAGNOSTICS');
    if (!auth.ok && !bootAdmin(req)) {
      return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    }
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

  app.get('/api/v1/network/devices', async (req, reply) => {
    const reg = getDeviceRegistry(root);
    const auth = authorizeSession(reg, sessionHeader(req), 'DEVICE_MANAGEMENT');
    if (!auth.ok && !bootAdmin(req)) {
      return reply.code(403).send(auth.ok === false ? auth : { ok: false });
    }
    return {
      ok: true,
      devices: reg.list().map((d) => ({
        device_id: d.device_id,
        device_type: d.device_type,
        status: d.status,
        private_address: d.private_address,
        connection_state: d.connection_state,
        client_id: d.client_id,
        key_fingerprint: d.key_fingerprint,
        key_version: d.key_version,
        last_seen: d.last_seen,
      })),
    };
  });
}
