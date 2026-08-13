import { FastifyInstance } from 'fastify';
import {
  getRobotSession,
  listRobotSessions,
  resolveRobotSession,
  robotBoardMeta,
  robotIdFor,
  startRobotSession,
  stopRobotSession,
} from '../services/robotDesk.js';
import { listDataSenders } from '../services/robotReader.js';

export async function registerRobotDeskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/robot-desk', async (request) => {
    const q = request.query as {
      id?: string;
      account_id?: string;
      epic?: string;
    };
    const accountId = q.account_id ? Number(q.account_id) : null;
    const sessions = listRobotSessions();
    const resolved = resolveRobotSession({
      id: q.id,
      account_id: accountId,
      epic: q.epic,
    });
    const senders = await listDataSenders().catch(() => []);
    return {
      active: resolved,
      sessions,
      board: robotBoardMeta(sessions),
      senders: senders
        .filter((s) => s.kind === 'capital_com')
        .map((s) => ({
          sender_id: s.sender_id,
          name: s.name,
          kind: s.kind,
          status: s.status,
          trust: s.trust,
          environment: s.environment,
          latency_ms: s.latency_ms,
          enabled: s.enabled !== false,
        })),
      expected_id:
        accountId && q.epic && Number.isFinite(accountId)
          ? robotIdFor(accountId, q.epic)
          : null,
    };
  });

  app.get('/api/robot-desk/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { account_id?: string; epic?: string };
    const accountId = q.account_id ? Number(q.account_id) : null;

    if (id === 'active' || id === 'resolve') {
      const resolved = resolveRobotSession({
        account_id: accountId,
        epic: q.epic,
      });
      if (!resolved) {
        return reply.code(404).send({
          error: 'No robot for this account+epic',
          message: 'No robot for this account+epic',
          expected_id:
            accountId && q.epic && Number.isFinite(accountId)
              ? robotIdFor(accountId, q.epic)
              : null,
        });
      }
      return resolved;
    }

    const s = getRobotSession(id);
    if (s) return s;

    // Fallback: if URL id stale but account+epic present, resolve correctly
    const fallback = resolveRobotSession({ account_id: accountId, epic: q.epic });
    if (fallback) return fallback;

    return reply.code(404).send({
      error: 'Robot session not found',
      message: 'Robot session not found',
      id,
    });
  });

  app.post('/api/robot-desk/start', async (request, reply) => {
    const body = (request.body || {}) as {
      account_id?: number;
      epic?: string;
      display_name?: string;
      lot_size?: number;
      trading_enabled?: boolean;
    };
    if (!body.account_id || !body.epic || body.lot_size == null) {
      return reply.code(400).send({
        error: 'account_id, epic, lot_size required',
        message: 'account_id, epic, lot_size required',
      });
    }
    try {
      const session = await startRobotSession({
        account_id: Number(body.account_id),
        epic: String(body.epic),
        display_name: body.display_name,
        lot_size: Number(body.lot_size),
        trading_enabled: body.trading_enabled !== false,
      });
      return { success: true, session };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Start failed';
      return reply.code(400).send({ error: message, message });
    }
  });

  app.post('/api/robot-desk/:id/stop', async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = (request.body || {}) as { account_id?: number; epic?: string };
    let target = id !== 'active' ? id : null;
    if (!target || !getRobotSession(target)) {
      const resolved = resolveRobotSession({
        id: target,
        account_id: q.account_id,
        epic: q.epic,
      });
      target = resolved?.id || null;
    }
    if (!target) {
      return reply.code(404).send({
        error: 'Robot session not found',
        message: 'Robot session not found',
      });
    }
    const session = await stopRobotSession(target);
    if (!session) {
      return reply.code(404).send({
        error: 'Robot session not found',
        message: 'Robot session not found',
      });
    }
    return { success: true, session };
  });
}
