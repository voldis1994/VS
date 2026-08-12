import { FastifyInstance } from 'fastify';
import {
  getRobotSession,
  listRobotSessions,
  startRobotSession,
  stopRobotSession,
} from '../services/robotDesk.js';

export async function registerRobotDeskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/robot-desk', async () => ({
    active: getRobotSession(),
    sessions: listRobotSessions(),
  }));

  app.get('/api/robot-desk/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const s = getRobotSession(id);
    if (!s || s.id !== id) {
      // allow "active" alias
      if (id === 'active') {
        const a = getRobotSession();
        if (!a) return reply.code(404).send({ error: 'No active robot' });
        return a;
      }
      return reply.code(404).send({ error: 'Robot session not found' });
    }
    return s;
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
    const target = id === 'active' ? getRobotSession()?.id : id;
    if (!target) return reply.code(404).send({ error: 'No active robot' });
    const session = await stopRobotSession(target);
    if (!session) return reply.code(404).send({ error: 'Robot session not found' });
    return { success: true, session };
  });
}
