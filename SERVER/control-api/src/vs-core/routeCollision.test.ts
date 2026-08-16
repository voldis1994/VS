import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerCanonicalV1Routes } from '../routes/canonicalV1.js';
import { registerMobileApiV1 } from './mobileApiV1.js';
import { registerAdminAgentRoutes } from './adminAgent.js';
import { MobileAuthService } from './mobileAuth.js';
import { probe } from './readiness.js';

/**
 * Physical boot regression: Fastify throws FST_ERR_DUPLICATED_ROUTE and
 * systemd exits if the same method+path is registered twice.
 */
describe('production route registration (no duplicates)', () => {
  it('registers mobile + adminAgent + canonicalV1 without FST_ERR_DUPLICATED_ROUTE', async () => {
    process.env.API_ADMIN_TOKEN = 'route-collision-token';
    const app = Fastify({ logger: false });
    const auth = new MobileAuthService(async () => false);
    const getProbes = async () => [probe('CONTROL_API', 'OK', 'test')];

    await expect(
      (async () => {
        await registerMobileApiV1(app, { auth, isAdmin: () => false, getProbes });
        await registerAdminAgentRoutes(app, { getProbes, adminToken: 'route-collision-token' });
        await registerCanonicalV1Routes(app, { getProbes, adminToken: 'route-collision-token' });
      })()
    ).resolves.toBeUndefined();

    const routes = app.printRoutes();
    expect(routes).toMatch(/incidents/);
    await app.close();
  });

  it('GET /api/v1/incidents accepts x-admin-token after combined registration', async () => {
    process.env.API_ADMIN_TOKEN = 'route-collision-token';
    const app = Fastify({ logger: false });
    const auth = new MobileAuthService(async () => false);
    const getProbes = async () => [probe('CONTROL_API', 'OK', 'test')];
    await registerMobileApiV1(app, { auth, isAdmin: () => false, getProbes });
    await registerAdminAgentRoutes(app, { getProbes, adminToken: 'route-collision-token' });
    await registerCanonicalV1Routes(app, { getProbes, adminToken: 'route-collision-token' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/incidents',
      headers: { 'x-admin-token': 'route-collision-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok?: boolean; incidents?: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.incidents)).toBe(true);
    await app.close();
  });
});
