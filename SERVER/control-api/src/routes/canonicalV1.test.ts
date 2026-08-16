import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerCanonicalV1Routes } from './canonicalV1.js';
import { probe } from '../vs-core/readiness.js';

describe('canonical /api/v1 surfaces', () => {
  it('rejects unauthenticated snapshot', async () => {
    process.env.API_ADMIN_TOKEN = 'canon-test-token';
    const app = Fastify({ logger: false });
    await registerCanonicalV1Routes(app, {
      getProbes: async () => [probe('CONTROL_API', 'OK', 'test')],
      adminToken: 'canon-test-token',
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/snapshot' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns snapshot with admin token (no invented LIVE)', async () => {
    process.env.API_ADMIN_TOKEN = 'canon-test-token';
    const app = Fastify({ logger: false });
    await registerCanonicalV1Routes(app, {
      getProbes: async () => [probe('CONTROL_API', 'OK', 'test')],
      adminToken: 'canon-test-token',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/system/snapshot',
      headers: { 'x-admin-token': 'canon-test-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.server_id || body.host).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/Math\.random/);
    await app.close();
  });
});
