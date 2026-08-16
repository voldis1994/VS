/**
 * CLIENT API — separate authorization boundary from ADMIN Control API.
 * Clients never receive ADMIN token, broker secrets, or server WG private key.
 */

import Fastify from 'fastify';
import { authorizeClientRequest } from './auth/authorize.js';

export type ClientApiOptions = {
  port?: number;
  host?: string;
  /** Upstream shared services (injected by appliance) */
  getClientStatus?: (clientId: string) => Promise<Record<string, unknown> | null>;
};

export async function buildClientApi(opts: ClientApiOptions = {}) {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({
    ok: true,
    role: 'client-api',
    trading_brain: 'vs-core-01',
  }));

  app.get('/api/v1/client/status', async (req, reply) => {
    const auth = authorizeClientRequest(req);
    if (!auth.ok) return reply.code(auth.status).send({ ok: false, code: auth.code });
    const status = opts.getClientStatus
      ? await opts.getClientStatus(auth.clientId)
      : { client_id: auth.clientId, trading: 'UNKNOWN', note: 'status provider not wired' };
    return { ok: true, ...status };
  });

  app.get('/api/v1/client/session', async (req, reply) => {
    const auth = authorizeClientRequest(req);
    if (!auth.ok) return reply.code(auth.status).send({ ok: false, code: auth.code });
    return {
      ok: true,
      client_id: auth.clientId,
      device_id: auth.deviceId,
      expires_at: auth.expiresAt,
    };
  });

  /** Deny ADMIN-shaped routes on client API process. */
  app.all('/api/v1/admin/*', async (_req, reply) => {
    return reply.code(403).send({ ok: false, code: 'CLIENT_FORBIDDEN_ADMIN' });
  });
  app.all('/api/v1/system/*', async (_req, reply) => {
    return reply.code(403).send({ ok: false, code: 'CLIENT_FORBIDDEN_ADMIN' });
  });

  return app;
}

export async function startClientApi(opts: ClientApiOptions = {}) {
  const app = await buildClientApi(opts);
  const port = opts.port ?? Number(process.env.CLIENT_API_PORT || 3001);
  const host = opts.host ?? '10.77.0.1';
  await app.listen({ port, host });
  return app;
}
