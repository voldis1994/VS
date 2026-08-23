import { FastifyInstance } from 'fastify';
import { requireClientSession } from './clientAuth.js';
import {
  assertNoSecrets,
  getClientPanelStatus,
  getClientQuote,
  listClientMarkets,
  saveClientConfig,
  startClientRobot,
  stopClientRobot,
} from '../services/clientPanel.js';

export async function registerClientPanelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/client/status', async (request, reply) => {
    const session = await requireClientSession(request, reply);
    if (!session) return;
    const status = await getClientPanelStatus(session.client_id);
    assertNoSecrets(status);
    return status;
  });

  app.get('/api/client/markets', async (request, reply) => {
    const session = await requireClientSession(request, reply);
    if (!session) return;
    const markets = await listClientMarkets(session.client_id);
    assertNoSecrets(markets);
    return { source: 'capital_com', markets };
  });

  app.get('/api/client/quote', async (request, reply) => {
    const session = await requireClientSession(request, reply);
    if (!session) return;
    const quote = await getClientQuote(session.client_id);
    if (!quote) {
      return reply.code(404).send({ error: 'No market configured', message: 'Select a market first' });
    }
    assertNoSecrets(quote);
    return quote;
  });

  app.put('/api/client/config', async (request, reply) => {
    const session = await requireClientSession(request, reply);
    if (!session) return;
    const body = (request.body || {}) as { epic?: string; lot_size?: number };
    if (!body.epic || body.lot_size == null) {
      return reply.code(400).send({
        error: 'epic and lot_size required',
        message: 'epic and lot_size required',
      });
    }
    try {
      const status = await saveClientConfig(session.client_id, {
        epic: String(body.epic),
        lot_size: Number(body.lot_size),
      });
      assertNoSecrets(status);
      return { success: true, status };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Config failed';
      return reply.code(400).send({ error: message, message });
    }
  });

  app.post('/api/client/start', async (request, reply) => {
    const session = await requireClientSession(request, reply);
    if (!session) return;
    // Ignore any client_id in body — session is source of truth
    try {
      const status = await startClientRobot(session.client_id);
      assertNoSecrets(status);
      // Subscription activated. RUNNING / STARTING / ERROR come from backend health.
      if (status.robot_status === 'STOPPED') {
        return reply.code(409).send({
          error: 'Subscription not confirmed',
          message: status.broker_error || status.status_reason || 'Robot did not activate',
          status,
        });
      }
      return { success: true, status };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Start failed';
      return reply.code(400).send({ error: message, message });
    }
  });

  app.post('/api/client/stop', async (request, reply) => {
    const session = await requireClientSession(request, reply);
    if (!session) return;
    try {
      const status = await stopClientRobot(session.client_id);
      assertNoSecrets(status);
      return { success: true, status };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stop failed';
      return reply.code(400).send({ error: message, message });
    }
  });
}
