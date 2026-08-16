/**
 * VS Private Network — PRODUCT automated proofs.
 * Physical WireGuard UP / i3 remain EXTERNAL_BLOCKER (never mocked PASS).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'fs';
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
import {
  issueEnrollmentPackage,
  completeEnrollment,
  revokeEnrollmentPackage,
  replaceLostDevice,
} from './enrollment.js';
import { assertClientScope, roleAllows } from './networkRoles.js';
import { hasPermission, CLIENT_PERMISSIONS, OWNER_ADMIN_PERMISSIONS } from './permissions.js';
import { resolveManagementBind } from './networkBind.js';
import { registerPrivateNetworkRoutes } from './networkApi.js';
import { runNetworkDiagnostics } from './networkDiagnostics.js';
import { executeIdempotent } from './commandIdempotency.js';
import { ConnectionManager, resolveServerEndpoint } from './connectionManager.js';
import { generateWgKeyPair } from './wireguardKeys.js';
import { appendNetworkAudit, assertNoSecretsInAuditFile } from './networkAudit.js';
import {
  STALE_AFTER_MS,
  DISCONNECT_AFTER_MS,
  VS_INTERNAL_SERVICES,
  clientHostIndexToIp,
  adminHostIndexToIp,
} from './networkConstants.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'vs-net-'));
}

describe('VS_PRIVATE_NETWORK_PRODUCT', () => {
  let root: string;

  beforeEach(() => {
    root = tmpRoot();
    process.env.VS_SERVER_DATA = root;
    process.env.VS_CORE_DATA = root;
    process.env.API_ADMIN_TOKEN = 'arch-net-admin-token';
    process.env.NODE_ENV = 'test';
    process.env.VS_PRIVATE_NETWORK_ALLOW_UNBOUND = '1';
    delete process.env.VS_PRIVATE_NETWORK;
    clearAppSessionsForTests();
    resetDeviceRegistryForTests(root);
  });

  it('addressing plan: SERVER .0.1, ADMIN 10.77.1.x, CLIENT 10.77.10.0/20', () => {
    expect(adminHostIndexToIp(1)).toBe('10.77.1.1');
    expect(clientHostIndexToIp(1)).toBe('10.77.10.1');
    expect(clientHostIndexToIp(256)).toBe('10.77.11.0');
    const reg = resetDeviceRegistryForTests(root);
    ensureServerIdentity(reg, root);
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    expect(admin.private_address).toBe('10.77.1.1');
    const client = registerClientDevice(reg, root, {
      client_id: 42,
      device_id: 'VS-CLIENT-000001',
    });
    expect(client.private_address).toBe('10.77.10.1');
    expect(reg.getMeta().server_private_ip).toBe('10.77.0.1');
  });

  it('SERVER identity persistence + no private keys in registry', () => {
    const reg = resetDeviceRegistryForTests(root);
    const server = ensureServerIdentity(reg, root);
    expect(server.server_id).toBe('VS-CORE-01');
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    const raw = readFileSync(join(root, 'network', 'device-registry.json'), 'utf8');
    expect(raw).not.toContain(admin.private_key_once);
    expect(raw).toContain(admin.public_key);
    const reloaded = new DeviceRegistry(root);
    expect(reloaded.getMeta().server_public_key).toBe(server.public_key);
  });

  it('ADMIN enrollment: create → complete with device public key → ACTIVE', () => {
    const reg = resetDeviceRegistryForTests(root);
    ensureServerIdentity(reg, root);
    const pkg = issueEnrollmentPackage(reg, {
      device_type: 'ADMIN',
      device_id: 'VS-ADMIN-01',
      created_by: 'test',
    });
    expect(pkg.enrollment_code).toBeTruthy();
    expect(pkg.note).toMatch(/Connection Manager/i);
    const pair = generateWgKeyPair();
    const done = completeEnrollment(reg, {
      enrollment_code: pkg.enrollment_code,
      public_key: pair.publicKey,
    });
    expect(done.device_id).toBe('VS-ADMIN-01');
    expect(done.private_address).toBe('10.77.1.1');
    expect(reg.get('VS-ADMIN-01')?.status).toBe('ACTIVE');
    // SERVER must not receive private key
    const raw = readFileSync(join(root, 'network', 'device-registry.json'), 'utf8');
    expect(raw).not.toContain(pair.privateKey);
  });

  it('CLIENT enrollment bound to client scope', () => {
    const reg = resetDeviceRegistryForTests(root);
    ensureServerIdentity(reg, root);
    const pkg = issueEnrollmentPackage(reg, {
      device_type: 'CLIENT',
      client_id: 7,
      created_by: 'admin',
    });
    const pair = generateWgKeyPair();
    const done = completeEnrollment(reg, {
      enrollment_code: pkg.enrollment_code,
      public_key: pair.publicKey,
    });
    expect(done.client_id).toBe(7);
    expect(done.device_id).toMatch(/^VS-CLIENT-/);
  });

  it('duplicate / expired / revoked enrollment rejected', () => {
    const reg = resetDeviceRegistryForTests(root);
    ensureServerIdentity(reg, root);
    const pkg = issueEnrollmentPackage(reg, {
      device_type: 'ADMIN',
      device_id: 'VS-ADMIN-01',
      created_by: 't',
    });
    const pair = generateWgKeyPair();
    completeEnrollment(reg, { enrollment_code: pkg.enrollment_code, public_key: pair.publicKey });
    expect(() =>
      completeEnrollment(reg, {
        enrollment_code: pkg.enrollment_code,
        public_key: generateWgKeyPair().publicKey,
      })
    ).toThrow(/ENROLLMENT_USED/);

    const pkg2 = issueEnrollmentPackage(reg, {
      device_type: 'ADMIN',
      device_id: 'VS-ADMIN-02',
      created_by: 't',
      ttl_ms: -1000,
    });
    expect(() =>
      completeEnrollment(reg, {
        enrollment_code: pkg2.enrollment_code,
        public_key: generateWgKeyPair().publicKey,
      })
    ).toThrow(/ENROLLMENT_EXPIRED/);

    const pkg3 = issueEnrollmentPackage(reg, {
      device_type: 'ADMIN',
      device_id: 'VS-ADMIN-03',
      created_by: 't',
    });
    revokeEnrollmentPackage(reg, pkg3.enrollment_id);
    expect(() =>
      completeEnrollment(reg, {
        enrollment_code: pkg3.enrollment_code,
        public_key: generateWgKeyPair().publicKey,
      })
    ).toThrow(/ENROLLMENT_REVOKED/);
  });

  it('permissions: OWNER_ADMIN vs CLIENT default DENY', () => {
    expect(hasPermission('OWNER_ADMIN', 'devices.manage')).toBe(true);
    expect(hasPermission('OWNER_ADMIN', 'terminal.admin')).toBe(true);
    expect(hasPermission('CLIENT', 'devices.manage')).toBe(false);
    expect(hasPermission('CLIENT', 'network.manage')).toBe(false);
    expect(hasPermission('CLIENT', 'own.trading.start')).toBe(true);
    expect(OWNER_ADMIN_PERMISSIONS.length).toBeGreaterThan(10);
    expect(CLIENT_PERMISSIONS).toContain('own.positions.read');
    expect(roleAllows('CLIENT', 'ADMIN_SERVICE')).toBe(false);
  });

  it('CLIENT A isolation; CLIENT → ADMIN denied; unknown/revoked denied', () => {
    const reg = resetDeviceRegistryForTests(root);
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    const c1 = registerClientDevice(reg, root, { client_id: 10, device_id: 'VS-CLIENT-000001' });
    registerClientDevice(reg, root, { client_id: 20, device_id: 'VS-CLIENT-000002' });

    const a = authenticateDevice(reg, { device_id: admin.device_id, device_token: admin.device_token });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(authorizeSession(reg, a.session.session_id, 'ADMIN_SERVICE').ok).toBe(true);

    const c = authenticateDevice(reg, { device_id: c1.device_id, device_token: c1.device_token });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(authorizeSession(reg, c.session.session_id, 'ADMIN_SERVICE').ok).toBe(false);
    expect(assertClientScope(c.device, 10).ok).toBe(true);
    expect(assertClientScope(c.device, 20).ok).toBe(false);

    expect(authenticateDevice(reg, { device_id: 'NOPE', device_token: 'x' }).ok).toBe(false);
    revokeDevice(reg, admin.device_id, root);
    expect(
      authenticateDevice(reg, { device_id: admin.device_id, device_token: admin.device_token }).ok
    ).toBe(false);
  });

  it('key rotation increments version; old token dead after reload', () => {
    const reg = resetDeviceRegistryForTests(root);
    ensureServerIdentity(reg, root);
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    const rotated = rotateDeviceKey(reg, root, admin.device_id);
    expect(rotated.key_version).toBe(2);
    expect(
      authenticateDevice(reg, { device_id: admin.device_id, device_token: admin.device_token }).ok
    ).toBe(false);
    expect(
      authenticateDevice(reg, { device_id: admin.device_id, device_token: rotated.device_token }).ok
    ).toBe(true);
    const reloaded = new DeviceRegistry(root);
    expect(reloaded.get('VS-ADMIN-01')?.key_version).toBe(2);
    expect(reloaded.verifyDeviceToken(admin.device_id, admin.device_token)).toBe(false);
  });

  it('lost device: revoke + new enrollment', () => {
    const reg = resetDeviceRegistryForTests(root);
    registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    const pkg = replaceLostDevice(reg, 'VS-ADMIN-01', 'owner');
    expect(reg.get('VS-ADMIN-01')?.status).toBe('REVOKED');
    expect(pkg.device_type).toBe('ADMIN');
    const pair = generateWgKeyPair();
    const done = completeEnrollment(reg, {
      enrollment_code: pkg.enrollment_code,
      public_key: pair.publicKey,
    });
    expect(done.device_id).not.toBe('VS-ADMIN-01');
  });

  it('heartbeat CONNECTED → STALE → DISCONNECTED; reconnect no command replay', () => {
    const reg = resetDeviceRegistryForTests(root);
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    const auth = authenticateDevice(reg, {
      device_id: admin.device_id,
      device_token: admin.device_token,
    });
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(reg.get(admin.device_id)?.connection_state).toBe('CONNECTED');
    const now = Date.now();
    reg.refreshConnectionStates(now + STALE_AFTER_MS + 1000);
    expect(reg.get(admin.device_id)?.connection_state).toBe('STALE');
    reg.refreshConnectionStates(now + DISCONNECT_AFTER_MS + 1000);
    expect(reg.get(admin.device_id)?.connection_state).toBe('DISCONNECTED');
    const r = reconnectSession(reg, auth.session.session_id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.trading_commands_replayed).toBe(false);
  });

  it('command idempotency: duplicate START returns same result once', () => {
    const reg = resetDeviceRegistryForTests(root);
    const c = registerClientDevice(reg, root, { client_id: 1, device_id: 'VS-CLIENT-000001' });
    let runs = 0;
    const r1 = executeIdempotent(reg, {
      command_id: 'cmd-start-aaaa-bbbb',
      device_id: c.device_id,
      kind: 'START',
      execute: () => {
        runs += 1;
        return { started: true };
      },
    });
    const r2 = executeIdempotent(reg, {
      command_id: 'cmd-start-aaaa-bbbb',
      device_id: c.device_id,
      kind: 'START',
      execute: () => {
        runs += 1;
        return { started: true };
      },
    });
    expect(r1.ok && !r1.duplicate).toBe(true);
    expect(r2.ok && r2.duplicate).toBe(true);
    expect(runs).toBe(1);
  });

  it('Connection Manager resolves SERVER_ID without user ports; catalog exists', () => {
    const ep = resolveServerEndpoint('VS-CORE-01', 'CONTROL_API');
    expect(ep.base_url).toContain('10.77.0.1');
    expect(VS_INTERNAL_SERVICES.CONTROL_API.private_port).toBe(3000);
    const uf = ConnectionManager.userFacingConfig('VS-CORE-01', 'VS-ADMIN-01');
    expect(uf).toEqual({ server_id: 'VS-CORE-01', device_id: 'VS-ADMIN-01' });
    expect(JSON.stringify(uf)).not.toMatch(/:\d{4}/);
  });

  it('fail-closed bind: production refuses open 0.0.0.0; LAN management allows firewall bind; WG-down throws without LAN', () => {
    expect(resolveManagementBind({ NODE_ENV: 'test' }).public_management_exposure).toBe('NONE');
    expect(() =>
      resolveManagementBind({ NODE_ENV: 'production', CONTROL_API_HOST: '0.0.0.0' })
    ).toThrow(/PUBLIC_BIND_DENIED/);
    const lan = resolveManagementBind({
      NODE_ENV: 'production',
      VS_LAN_MANAGEMENT: '1',
      VS_PRIVATE_NETWORK: '1',
    });
    expect(lan.host).toBe('0.0.0.0');
    expect(lan.public_management_exposure).toBe('LAN_FIREWALL_REQUIRED');
    expect(() =>
      resolveManagementBind({
        VS_PRIVATE_NETWORK: '1',
        NODE_ENV: 'production',
        VS_PRIVATE_NETWORK_ALLOW_UNBOUND: undefined,
        VITEST: undefined,
      } as NodeJS.ProcessEnv)
    ).toThrow(/WIREGUARD_NOT_READY/);
  });

  it('HTTP: enrollment, isolation, command dedupe, me endpoint', async () => {
    const reg = resetDeviceRegistryForTests(root);
    ensureServerIdentity(reg, root);
    const admin = registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });
    const c1 = registerClientDevice(reg, root, { client_id: 1, device_id: 'VS-CLIENT-000001' });
    registerClientDevice(reg, root, { client_id: 2, device_id: 'VS-CLIENT-000002' });

    const app = Fastify({ logger: false });
    await registerPrivateNetworkRoutes(app);

    const adminAuth = await app.inject({
      method: 'POST',
      url: '/api/v1/network/device/auth',
      payload: { device_id: admin.device_id, device_token: admin.device_token },
    });
    const adminSession = adminAuth.json().session_id as string;

    const clientAuth = await app.inject({
      method: 'POST',
      url: '/api/v1/network/device/auth',
      payload: { device_id: c1.device_id, device_token: c1.device_token },
    });
    const clientSession = clientAuth.json().session_id as string;

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/network/admin/only',
          headers: { 'x-vs-session': clientSession },
        })
      ).statusCode
    ).toBe(403);

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/network/client/2/scope',
          headers: { 'x-vs-session': clientSession },
        })
      ).statusCode
    ).toBe(403);

    const cmd1 = await app.inject({
      method: 'POST',
      url: '/api/v1/network/command',
      headers: { 'x-vs-session': clientSession },
      payload: { command_id: 'idem-start-00123456', kind: 'START' },
    });
    expect(cmd1.statusCode).toBe(200);
    expect(cmd1.json().duplicate).toBe(false);
    const cmd2 = await app.inject({
      method: 'POST',
      url: '/api/v1/network/command',
      headers: { 'x-vs-session': clientSession },
      payload: { command_id: 'idem-start-00123456', kind: 'START' },
    });
    expect(cmd2.json().duplicate).toBe(true);

    const spoof = await app.inject({
      method: 'POST',
      url: '/api/v1/network/command',
      headers: { 'x-vs-session': clientSession },
      payload: { command_id: 'idem-start-spoof9999', kind: 'START', client_id: 2 },
    });
    expect(spoof.statusCode).toBe(403);

    const enr = await app.inject({
      method: 'POST',
      url: '/api/v1/network/enrollment/create',
      headers: { 'x-vs-session': adminSession },
      payload: { device_type: 'CLIENT', client_id: 99 },
    });
    expect(enr.statusCode).toBe(200);
    const code = enr.json().enrollment_code as string;
    const pair = generateWgKeyPair();
    const done = await app.inject({
      method: 'POST',
      url: '/api/v1/network/enrollment/complete',
      payload: { enrollment_code: code, public_key: pair.publicKey },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().client_id).toBe(99);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/network/me',
      headers: { 'x-vs-session': clientSession },
    });
    expect(me.json().client_id).toBe(1);

    await app.close();
    void reg;
  });

  it('HTTP: MSI admin token (bootAdmin) can list devices and enrollments', async () => {
    const prev = process.env.API_ADMIN_TOKEN;
    process.env.API_ADMIN_TOKEN = 'test-msi-admin-token';
    try {
      const reg = resetDeviceRegistryForTests(root);
      ensureServerIdentity(reg, root);
      registerAdminDevice(reg, root, { device_id: 'VS-ADMIN-01' });

      const app = Fastify({ logger: false });
      await registerPrivateNetworkRoutes(app);

      const denied = await app.inject({ method: 'GET', url: '/api/v1/network/devices' });
      expect(denied.statusCode).toBe(403);

      const devices = await app.inject({
        method: 'GET',
        url: '/api/v1/network/devices',
        headers: { 'x-admin-token': 'test-msi-admin-token' },
      });
      expect(devices.statusCode).toBe(200);
      expect(devices.json().devices.length).toBeGreaterThanOrEqual(1);

      const enrollments = await app.inject({
        method: 'GET',
        url: '/api/v1/network/enrollments',
        headers: { 'x-admin-token': 'test-msi-admin-token' },
      });
      expect(enrollments.statusCode).toBe(200);
      expect(Array.isArray(enrollments.json().enrollments)).toBe(true);

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/network/enrollment/create',
        headers: { 'x-admin-token': 'test-msi-admin-token' },
        payload: { device_type: 'CLIENT', client_id: 7 },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().enrollment_code).toBeTruthy();

      await app.close();
    } finally {
      if (prev === undefined) delete process.env.API_ADMIN_TOKEN;
      else process.env.API_ADMIN_TOKEN = prev;
    }
  });

  it('audit never stores private keys/tokens', () => {
    const secret = 'SUPER_SECRET_PRIVATE_KEY_MATERIAL_xyz';
    appendNetworkAudit(root, {
      action: 'LOGIN',
      actor: 'VS-ADMIN-01',
      result: 'OK',
      detail: { device_token: secret, private_key: secret },
    });
    assertNoSecretsInAuditFile(root, [secret]);
  });

  it('diagnostics never invents PHYSICAL PASS', () => {
    const reg = resetDeviceRegistryForTests(root);
    ensureServerIdentity(reg, root);
    const diag = runNetworkDiagnostics({ dataRoot: root, registry: reg });
    expect(diag.lines.some((l) => l.name === 'PHYSICAL_i3' && l.status === 'EXTERNAL_BLOCKER')).toBe(
      true
    );
    expect(
      diag.lines.some((l) => l.name === 'SERVER_EXTERNAL_REACHABILITY' && l.status === 'EXTERNAL_BLOCKER')
    ).toBe(true);
  });

  it('no private keys under network source tree', () => {
    const netDir = join(process.cwd(), 'src', 'vs-core', 'network');
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      if (!existsSync(dir)) return out;
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) out.push(...walk(p));
        else if (name.name.endsWith('.private')) out.push(p);
      }
      return out;
    };
    expect(walk(netDir)).toEqual([]);
  });
});
