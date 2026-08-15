/**
 * Mobile Control API /api/v1 — remote control + monitoring only.
 * Not an execution API: cannot construct arbitrary broker orders.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MobileAuthService } from './mobileAuth.js';
import { getClientTradingRegistry } from './clientTrading.js';
import { getIncidentCenter } from './incidentCenter.js';
import { evaluateReadiness, type ProbeResult } from './readiness.js';
import { versionBundle, CORE_VERSION, STRATEGY_VERSION } from './versions.js';
import { getEventBus } from './eventBus.js';
import { setRobotsTradingEnabled } from '../services/robotDesk.js';

export type MobileApiDeps = {
  auth: MobileAuthService;
  isAdmin?: (clientId: number) => boolean;
  getProbes?: () => ProbeResult[] | Promise<ProbeResult[]>;
  getMarket?: (clientId: number) => Promise<{
    bid: number | null;
    ask: number | null;
    spread: number | null;
    status: string;
  }>;
  getStrategyState?: (clientId: number) => Promise<Record<string, unknown>>;
  getPosition?: (clientId: number) => Promise<Record<string, unknown> | null>;
  getLotSize?: (clientId: number) => Promise<number>;
  setLotSize?: (clientId: number, lot: number) => Promise<{ ok: boolean; reason?: string }>;
};

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

export async function registerMobileApiV1(app: FastifyInstance, deps: MobileApiDeps): Promise<void> {
  const reg = getClientTradingRegistry();
  const incidents = getIncidentCenter();
  const bus = getEventBus();

  app.post('/api/v1/login', async (req, reply) => {
    const body = (req.body || {}) as {
      client_id?: number;
      password?: string;
      device_id?: string;
    };
    if (!body.client_id || !body.password || !body.device_id) {
      return reply.code(400).send({ ok: false, code: 'INVALID_INPUT', reason: 'client_id, password, device_id required' });
    }
    const result = await deps.auth.login({
      client_id: body.client_id,
      password: body.password,
      device_id: body.device_id,
      ip: req.ip,
    });
    if (!result.ok) return reply.code(401).send(result);
    await bus.emit('ClientAuthenticated', {
      source: 'mobile-api',
      client_id: body.client_id,
      payload: { action: 'login', device_id: body.device_id },
    });
    return {
      ok: true,
      token: result.token,
      refresh_token: result.refresh_token,
      expires_at: result.expires_at,
      session_id: result.session_id,
    };
  });

  app.post('/api/v1/logout', async (req, reply) => {
    const token = bearer(req);
    if (!token) return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    deps.auth.revoke(token);
    return { ok: true };
  });

  app.post('/api/v1/refresh', async (req, reply) => {
    const body = (req.body || {}) as { refresh_token?: string };
    if (!body.refresh_token) {
      return reply.code(400).send({ ok: false, code: 'INVALID_INPUT' });
    }
    const result = deps.auth.refresh(body.refresh_token);
    if (!result.ok) return reply.code(401).send(result);
    return result;
  });

  const requireSession = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const session = deps.auth.resolve(bearer(req));
    if (!session) {
      await reply.code(401).send({ ok: false, code: 'UNAUTHORIZED', reason: 'Invalid or expired token' });
      return null;
    }
    return session;
  };

  app.get('/api/v1/system/status', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const probes = deps.getProbes ? await deps.getProbes() : [];
    const report = evaluateReadiness(probes);
    const admin = deps.isAdmin?.(session.client_id) === true;
    if (!admin) {
      return {
        ok: true,
        role: 'client',
        trading_enabled: reg.isTradingEnabled(session.client_id),
        system_state: report.state,
        versions: {
          core_version: CORE_VERSION,
          strategy_version: STRATEGY_VERSION,
        },
      };
    }
    return {
      ok: true,
      role: 'admin',
      ...report,
      versions: versionBundle(),
    };
  });

  app.get('/api/v1/market', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const m = deps.getMarket
      ? await deps.getMarket(session.client_id)
      : { bid: null, ask: null, spread: null, status: 'NO_DATA' };
    return { ok: true, ...m };
  });

  app.get('/api/v1/strategy', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const state = deps.getStrategyState
      ? await deps.getStrategyState(session.client_id)
      : {};
    return { ok: true, strategy_version: STRATEGY_VERSION, ...state };
  });

  app.get('/api/v1/position', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const pos = deps.getPosition ? await deps.getPosition(session.client_id) : null;
    return { ok: true, position: pos };
  });

  app.get('/api/v1/lot-size', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const lot = deps.getLotSize ? await deps.getLotSize(session.client_id) : 0;
    return { ok: true, lot_size: lot };
  });

  app.put('/api/v1/lot-size', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const body = (req.body || {}) as { lot_size?: number };
    if (body.lot_size == null || !(body.lot_size > 0) || !Number.isFinite(body.lot_size)) {
      return reply.code(400).send({ ok: false, code: 'INVALID_LOT', reason: 'lot_size must be > 0' });
    }
    if (!deps.setLotSize) {
      return reply.code(501).send({ ok: false, code: 'NOT_CONFIGURED' });
    }
    const r = await deps.setLotSize(session.client_id, body.lot_size);
    if (!r.ok) return reply.code(400).send({ ok: false, code: 'INVALID_LOT', reason: r.reason });
    return { ok: true, lot_size: body.lot_size };
  });

  app.post('/api/v1/trading/start', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const body = (req.body || {}) as { account_id?: number };
    const accountId = body.account_id ?? null;
    const state = reg.start(session.client_id, accountId);
    const robots = setRobotsTradingEnabled(session.client_id, accountId, true);
    await bus.emit('ClientTradingStarted', {
      source: 'mobile-api',
      client_id: session.client_id,
      payload: { state, robots_enabled: robots, account_id: accountId },
    });
    return { ok: true, state, robots_enabled: robots };
  });

  app.post('/api/v1/trading/stop', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const body = (req.body || {}) as { account_id?: number };
    const accountId = body.account_id ?? null;
    const state = reg.stop(session.client_id, accountId);
    const robots = setRobotsTradingEnabled(session.client_id, accountId, false);
    await bus.emit('ClientTradingStopped', {
      source: 'mobile-api',
      client_id: session.client_id,
      payload: {
        state,
        robots_disabled: robots,
        account_id: accountId,
        position_policy: state.stop_position_policy,
      },
    });
    return { ok: true, state, robots_disabled: robots };
  });

  app.get('/api/v1/incidents', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const admin = deps.isAdmin?.(session.client_id) === true;
    const list = admin
      ? incidents.list({ unresolved_only: true })
      : incidents.list({ unresolved_only: true, client_id: session.client_id });
    return { ok: true, incidents: list };
  });

  app.get('/api/v1/logs', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const admin = deps.isAdmin?.(session.client_id) === true;
    const events = bus.recent(100).filter((e) => {
      if (admin) return true;
      // Client: only own client_id — never global null client_id system events
      return e.client_id === session.client_id;
    });
    return { ok: true, events };
  });

  app.post('/api/v1/broker/order', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    return reply.code(403).send({
      ok: false,
      code: 'CONTROL_API_NOT_EXECUTION_API',
      reason:
        'Mobile cannot submit arbitrary broker orders. Orders flow Strategy → Risk → Execution only.',
    });
  });

  app.get('/api/v1/clients/:clientId/status', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const target = Number((req.params as { clientId: string }).clientId);
    if (!deps.auth.assertClientAccess(session, target) && deps.isAdmin?.(session.client_id) !== true) {
      return reply.code(403).send({ ok: false, code: 'CLIENT_ISOLATION_DENIED' });
    }
    return {
      ok: true,
      client_id: target,
      trading_enabled: reg.isTradingEnabled(target),
    };
  });
}
