/**
 * /api/v1 endpoint inventory + auth/isolation security tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerMobileApiV1 } from './mobileApiV1.js';
import { registerAdminAgentRoutes } from './adminAgent.js';
import { MobileAuthService } from './mobileAuth.js';
import { probe } from './readiness.js';

export const API_V1_INVENTORY = [
  { method: 'POST', path: '/api/v1/login', auth: 'public', isolation: 'n/a', notes: 'rate-limited login' },
  { method: 'POST', path: '/api/v1/logout', auth: 'bearer', isolation: 'self', notes: 'revoke token' },
  { method: 'POST', path: '/api/v1/refresh', auth: 'refresh_token', isolation: 'n/a', notes: 'body refresh' },
  { method: 'GET', path: '/api/v1/system/status', auth: 'bearer', isolation: 'role-scoped', notes: 'client slice vs admin full' },
  { method: 'GET', path: '/api/v1/market', auth: 'bearer', isolation: 'self', notes: 'client market' },
  { method: 'GET', path: '/api/v1/strategy', auth: 'bearer', isolation: 'self', notes: 'client strategy' },
  { method: 'GET', path: '/api/v1/position', auth: 'bearer', isolation: 'self', notes: 'client position' },
  { method: 'GET', path: '/api/v1/lot-size', auth: 'bearer', isolation: 'self', notes: 'read lot' },
  { method: 'PUT', path: '/api/v1/lot-size', auth: 'bearer', isolation: 'self', notes: 'validated lot > 0' },
  { method: 'POST', path: '/api/v1/trading/start', auth: 'bearer', isolation: 'self', notes: 'start trading' },
  { method: 'POST', path: '/api/v1/trading/stop', auth: 'bearer', isolation: 'self', notes: 'stop trading' },
  { method: 'GET', path: '/api/v1/incidents', auth: 'bearer', isolation: 'self-or-admin', notes: 'client filtered' },
  { method: 'GET', path: '/api/v1/logs', auth: 'bearer', isolation: 'self-or-admin', notes: 'client filtered' },
  { method: 'POST', path: '/api/v1/broker/order', auth: 'bearer', isolation: 'n/a', notes: 'always 403 execution deny' },
  { method: 'GET', path: '/api/v1/clients/:clientId/status', auth: 'bearer', isolation: 'strict', notes: 'A→B denied' },
  { method: 'GET', path: '/api/v1/admin/health', auth: 'x-admin-token', isolation: 'admin-only', notes: 'admin agent' },
  { method: 'GET', path: '/api/v1/admin/tui', auth: 'x-admin-token', isolation: 'admin-only', notes: 'admin tui text' },
  { method: 'GET', path: '/api/v1/server/monitor', auth: 'x-admin-token', isolation: 'admin-only', notes: 'unified server monitor' },
  { method: 'GET', path: '/api/v1/server/monitor/text', auth: 'x-admin-token', isolation: 'admin-only', notes: 'monitor plaintext frame' },
  { method: 'GET', path: '/api/v1/system/supervisor', auth: 'x-admin-token', isolation: 'admin-only', notes: 'process vs trading readiness' },
  { method: 'GET', path: '/api/v1/system/kill-switch', auth: 'x-admin-token', isolation: 'admin-only', notes: 'kill switch state' },
  { method: 'POST', path: '/api/v1/system/kill-switch', auth: 'x-admin-token', isolation: 'admin-only', notes: 'kill switch set' },
  { method: 'GET', path: '/api/v1/broker/health', auth: 'x-admin-token', isolation: 'admin-only', notes: 'broker CONFIG_REQUIRED/health' },
] as const;

async function buildApp() {
  const app = Fastify({ logger: false });
  const auth = new MobileAuthService(async (id, pw) => id === 1 && pw === 'good');
  await registerMobileApiV1(app, {
    auth,
    isAdmin: (id) => id === 99,
    getProbes: () => [
      probe('NETWORK', 'OK', 'ok'),
      probe('TIME', 'OK', 'ok'),
      probe('STORAGE', 'OK', 'ok'),
      probe('DATABASE', 'OK', 'ok'),
      probe('MARKET', 'OK', 'ok'),
      probe('CAPITAL', 'ERROR', 'no', 'CAPITAL_UNVERIFIED'),
      probe('STRATEGY', 'OK', 'ok'),
      probe('RISK', 'OK', 'ok'),
      probe('EXECUTION', 'OK', 'ok'),
      probe('RECONCILIATION', 'OK', 'ok'),
    ],
  });
  await registerAdminAgentRoutes(app, {
    getProbes: async () => [],
    adminToken: 'admin-secret',
  });
  await app.ready();
  return { app, auth };
}

describe('/api/v1 security inventory', () => {
  it('documents all registered /api/v1 routes', () => {
    expect(API_V1_INVENTORY.length).toBeGreaterThanOrEqual(15);
    expect(API_V1_INVENTORY.every((e) => e.path.startsWith('/api/v1/'))).toBe(true);
  });

  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let auth: MobileAuthService;

  beforeEach(async () => {
    const b = await buildApp();
    app = b.app;
    auth = b.auth;
  });

  it('no token → 401 on protected routes', async () => {
    for (const path of [
      '/api/v1/system/status',
      '/api/v1/market',
      '/api/v1/strategy',
      '/api/v1/position',
      '/api/v1/lot-size',
      '/api/v1/trading/start',
      '/api/v1/incidents',
      '/api/v1/logs',
      '/api/v1/broker/order',
      '/api/v1/clients/1/status',
    ]) {
      const method = path.includes('trading') || path.includes('broker') ? 'POST' : 'GET';
      const res = await app.inject({ method, url: path });
      expect(res.statusCode).toBe(401);
    }
  });

  it('invalid / revoked token denied; Client A cannot access Client B', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/market',
      headers: { authorization: 'Bearer not-a-token' },
    });
    expect(bad.statusCode).toBe(401);

    const login = await auth.login({
      client_id: 1,
      password: 'good',
      device_id: 'd1',
      ip: '1.1.1.1',
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/market',
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(ok.statusCode).toBe(200);

    const cross = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/2/status',
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(cross.statusCode).toBe(403);
    expect(cross.json().code).toBe('CLIENT_ISOLATION_DENIED');

    auth.revoke(login.token);
    const revoked = await app.inject({
      method: 'GET',
      url: '/api/v1/market',
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(revoked.statusCode).toBe(401);
  });

  it('client cannot hit admin endpoints; admin token required', async () => {
    const login = await auth.login({
      client_id: 1,
      password: 'good',
      device_id: 'd2',
      ip: '1.1.1.1',
    });
    if (!login.ok) throw new Error('login');
    const asClient = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/health',
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(asClient.statusCode).toBe(401);

    const noTok = await app.inject({ method: 'GET', url: '/api/v1/admin/health' });
    expect(noTok.statusCode).toBe(401);

    const admin = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/health',
      headers: { 'x-admin-token': 'admin-secret' },
    });
    expect(admin.statusCode).toBe(200);
  });

  it('malformed login / invalid lot rejected', async () => {
    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      payload: { client_id: 1 },
    });
    expect(badLogin.statusCode).toBe(400);

    const login = await auth.login({
      client_id: 1,
      password: 'good',
      device_id: 'd3',
      ip: '1.1.1.1',
    });
    if (!login.ok) throw new Error('login');
    const lot = await app.inject({
      method: 'PUT',
      url: '/api/v1/lot-size',
      headers: { authorization: `Bearer ${login.token}` },
      payload: { lot_size: -1 },
    });
    expect(lot.statusCode).toBe(400);

    const broker = await app.inject({
      method: 'POST',
      url: '/api/v1/broker/order',
      headers: { authorization: `Bearer ${login.token}` },
      payload: { epic: 'GOLD', size: 1 },
    });
    expect(broker.statusCode).toBe(403);
    expect(broker.json().code).toBe('CONTROL_API_NOT_EXECUTION_API');
  });
});
