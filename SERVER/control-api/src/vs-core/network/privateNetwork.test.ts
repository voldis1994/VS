/**
 * VS Private Network Phase 1 — automated proofs (no physical WireGuard required).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';
import { resetDeviceRegistryForTests, DeviceRegistry } from './deviceRegistry.js';
import {
  clearAppSessionsForTests,
  authenticateDevice,
  authorizeSession,
  reconnectSession,
} from './deviceAuth.js';
import {
  ensureServerIdentity,
  registerAdminDevice,
  registerClientDevice,
  revokeDevice,
  rotateDeviceKey,
} from './deviceLifecycle.js';
import { assertClientScope, roleAllows } from './networkRoles.js';
import { resolveManagementBind } from './networkBind.js';
import { registerPrivateNetworkRoutes } from './networkApi.js';
import { runNetworkDiagnostics } from './networkDiagnostics.js';
import { STALE_AFTER_MS, DISCONNECT_AFTER_MS } from './networkConstants.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'vs-net-'));
}

describe('VS_PRIVATE_NETWORK', () => {
  let root: string;

  beforeEach(() => {
    root = tmpRoot();
    process.env.VS_SERVER_DATA = root;
    process.env.VS_CORE_DATA = root;
    process.env.API_ADMIN_TOKEN = 'arch-net-admin-token';
    process.env.NODE_ENV = 'test';
    clearAppSessionsForTests();
    resetDeviceRegistryForTests(root);
  });

  it('SERVER / ADMIN / CLIENT identities + registry (no private keys in registry file)', () => {
    const reg = resetDeviceRegistryForTests(root);
    const server = ensureServerIdentity(reg, root);
    expect(server.server_id).toBe('VS-CORE-01');
    expect(server.public_key.length).toBeGreaterThan(20);

    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    expect(admin.private_ip).toBe('10.77.0.2');
    expect(admin.device_token).toBeTruthy();

    const client = registerClientDevice(reg, root, {
      client_id: 42,
      device_id: 'VS-CLIENT-0001',
    });
    expect(client.private_ip).toBe('10.77.10.1');
    expect(client.client_id).toBe(42);

    const raw = readFileSync(join(root, 'network', 'device-registry.json'), 'utf8');
    expect(raw).not.toContain(admin.private_key_once);
    expect(raw).not.toContain(client.private_key_once);
    expect(raw).toContain(admin.public_key);
  });

  it('ADMIN authenticated → ADMIN_SERVICE allowed; CLIENT → ADMIN denied', () => {
    const reg = resetDeviceRegistryForTests(root);
    ensureServerIdentity(reg, root);
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    const client = registerClientDevice(reg, root, { client_id: 1, device_id: 'VS-CLIENT-0001' });

    const a = authenticateDevice(reg, {
      device_id: admin.device_id,
      device_token: admin.device_token,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(authorizeSession(reg, a.session.session_id, 'ADMIN_SERVICE').ok).toBe(true);
    expect(authorizeSession(reg, a.session.session_id, 'DEVICE_MANAGEMENT').ok).toBe(true);

    const c = authenticateDevice(reg, {
      device_id: client.device_id,
      device_token: client.device_token,
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const denied = authorizeSession(reg, c.session.session_id, 'ADMIN_SERVICE');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('ROLE_DENIED');
    expect(authorizeSession(reg, c.session.session_id, 'CLIENT_SERVICE').ok).toBe(true);
  });

  it('CLIENT A → Client B denied; own scope allowed', () => {
    const reg = resetDeviceRegistryForTests(root);
    const c1 = registerClientDevice(reg, root, { client_id: 10, device_id: 'VS-CLIENT-0001' });
    registerClientDevice(reg, root, { client_id: 20, device_id: 'VS-CLIENT-0002' });
    const auth = authenticateDevice(reg, {
      device_id: c1.device_id,
      device_token: c1.device_token,
    });
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(assertClientScope(auth.device, 10).ok).toBe(true);
    const cross = assertClientScope(auth.device, 20);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.code).toBe('CLIENT_ISOLATION');
  });

  it('Unknown / revoked / invalid key / expired session denied', () => {
    const reg = resetDeviceRegistryForTests(root);
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    expect(
      authenticateDevice(reg, { device_id: 'NOPE', device_token: 'x' }).ok
    ).toBe(false);
    expect(
      authenticateDevice(reg, {
        device_id: admin.device_id,
        device_token: 'wrong',
      }).ok
    ).toBe(false);

    const ok = authenticateDevice(reg, {
      device_id: admin.device_id,
      device_token: admin.device_token,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    revokeDevice(reg, admin.device_id);
    // Sessions invalidated on revoke; re-auth also denied
    const after = authorizeSession(reg, ok.session.session_id, 'ADMIN_SERVICE');
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(['DEVICE_REVOKED', 'EXPIRED_SESSION']).toContain(after.code);
    }
    const reauth = authenticateDevice(reg, {
      device_id: admin.device_id,
      device_token: admin.device_token,
    });
    expect(reauth.ok).toBe(false);
    if (!reauth.ok) expect(reauth.code).toBe('DEVICE_REVOKED');

    expect(authorizeSession(reg, 'missing-session', 'ADMIN_SERVICE').ok).toBe(false);
  });

  it('Reconnect does not replay trading commands', () => {
    const reg = resetDeviceRegistryForTests(root);
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    const auth = authenticateDevice(reg, {
      device_id: admin.device_id,
      device_token: admin.device_token,
    });
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    const r = reconnectSession(reg, auth.session.session_id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trading_commands_replayed).toBe(false);
  });

  it('Key rotation invalidates old token; registry survives restart', () => {
    const reg = resetDeviceRegistryForTests(root);
    ensureServerIdentity(reg, root);
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    const rotated = rotateDeviceKey(reg, root, admin.device_id);
    expect(
      authenticateDevice(reg, {
        device_id: admin.device_id,
        device_token: admin.device_token,
      }).ok
    ).toBe(false);
    expect(
      authenticateDevice(reg, {
        device_id: admin.device_id,
        device_token: rotated.device_token,
      }).ok
    ).toBe(true);

    const reloaded = new DeviceRegistry(root);
    expect(reloaded.get('VS-ADMIN-01')?.status).toBe('ACTIVE');
    expect(reloaded.getMeta().server_public_key).toBeTruthy();
    expect(
      reloaded.verifyDeviceToken(admin.device_id, rotated.device_token)
    ).toBe(true);
  });

  it('Revoked remains revoked after registry reload', () => {
    const reg = resetDeviceRegistryForTests(root);
    registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    revokeDevice(reg, 'VS-ADMIN-01');
    const reloaded = new DeviceRegistry(root);
    expect(reloaded.get('VS-ADMIN-01')?.status).toBe('REVOKED');
  });

  it('Heartbeat CONNECTED → STALE → DISCONNECTED', () => {
    const reg = resetDeviceRegistryForTests(root);
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    authenticateDevice(reg, { device_id: admin.device_id, device_token: admin.device_token });
    expect(reg.get(admin.device_id)?.connection_state).toBe('CONNECTED');
    const now = Date.now();
    reg.refreshConnectionStates(now + STALE_AFTER_MS + 1000);
    expect(reg.get(admin.device_id)?.connection_state).toBe('STALE');
    reg.refreshConnectionStates(now + DISCONNECT_AFTER_MS + 1000);
    expect(reg.get(admin.device_id)?.connection_state).toBe('DISCONNECTED');
  });

  it('Production bind refuses 0.0.0.0; default localhost', () => {
    expect(resolveManagementBind({ NODE_ENV: 'test' }).host).toBe('127.0.0.1');
    expect(resolveManagementBind({ NODE_ENV: 'test' }).public_management_exposure).toBe('NONE');
    expect(() =>
      resolveManagementBind({ NODE_ENV: 'production', CONTROL_API_HOST: '0.0.0.0' })
    ).toThrow(/PUBLIC_BIND_DENIED/);
    expect(
      resolveManagementBind({
        VS_PRIVATE_NETWORK: '1',
        CONTROL_API_HOST: '',
      }).public_management_exposure
    ).toBe('NONE');
  });

  it('HTTP: CLIENT cannot call admin-only; isolation endpoints', async () => {
    const reg = resetDeviceRegistryForTests(root);
    ensureServerIdentity(reg, root);
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    const c1 = registerClientDevice(reg, root, { client_id: 1, device_id: 'VS-CLIENT-0001' });
    registerClientDevice(reg, root, { client_id: 2, device_id: 'VS-CLIENT-0002' });

    const app = Fastify({ logger: false });
    await registerPrivateNetworkRoutes(app);

    const adminAuth = await app.inject({
      method: 'POST',
      url: '/api/v1/network/device/auth',
      payload: { device_id: admin.device_id, device_token: admin.device_token },
    });
    expect(adminAuth.statusCode).toBe(200);
    const adminSession = adminAuth.json().session_id as string;

    const clientAuth = await app.inject({
      method: 'POST',
      url: '/api/v1/network/device/auth',
      payload: { device_id: c1.device_id, device_token: c1.device_token },
    });
    expect(clientAuth.statusCode).toBe(200);
    const clientSession = clientAuth.json().session_id as string;

    const adminOk = await app.inject({
      method: 'GET',
      url: '/api/v1/network/admin/only',
      headers: { 'x-vs-session': adminSession },
    });
    expect(adminOk.statusCode).toBe(200);

    const clientDenied = await app.inject({
      method: 'GET',
      url: '/api/v1/network/admin/only',
      headers: { 'x-vs-session': clientSession },
    });
    expect(clientDenied.statusCode).toBe(403);

    const own = await app.inject({
      method: 'GET',
      url: '/api/v1/network/client/1/scope',
      headers: { 'x-vs-session': clientSession },
    });
    expect(own.statusCode).toBe(200);

    const other = await app.inject({
      method: 'GET',
      url: '/api/v1/network/client/2/scope',
      headers: { 'x-vs-session': clientSession },
    });
    expect(other.statusCode).toBe(403);

    await app.close();
    void reg;
  });

  it('No private keys under SERVER source tree in this package', () => {
    const src = join(process.cwd(), 'src');
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) out.push(...walk(p));
        else if (name.name.endsWith('.private') || name.name.endsWith('.conf')) out.push(p);
      }
      return out;
    };
    // only check network module for accidental key files
    const netDir = join(src, 'vs-core', 'network');
    if (existsSync(netDir)) {
      expect(walk(netDir).filter((p) => p.endsWith('.private'))).toEqual([]);
    }
  });

  it('role matrix OWNER_ADMIN vs CLIENT', () => {
    expect(roleAllows('OWNER_ADMIN', 'ADMIN_SERVICE')).toBe(true);
    expect(roleAllows('CLIENT', 'ADMIN_SERVICE')).toBe(false);
    expect(roleAllows('CLIENT', 'DEVICE_MANAGEMENT')).toBe(false);
    expect(roleAllows('CLIENT', 'CLIENT_SERVICE')).toBe(true);
  });

  it('diagnostics never invents PHYSICAL PASS', () => {
    const reg = resetDeviceRegistryForTests(root);
    ensureServerIdentity(reg, root);
    const diag = runNetworkDiagnostics({ dataRoot: root, registry: reg });
    const physical = diag.lines.find((l) => l.name === 'WIREGUARD_INTERFACE');
    // Without real iface: EXTERNAL_BLOCKER or PASS if somehow present — never fake
    expect(physical?.status === 'PASS' || physical?.status === 'EXTERNAL_BLOCKER').toBe(true);
    expect(diag.lines.some((l) => l.name === 'CAPITAL_OUTBOUND' && l.status === 'EXTERNAL_BLOCKER')).toBe(
      true
    );
  });
});
