import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import {
  getMultiMarketStatus,
  startMultiMarketSelector,
  stopMultiMarketSelector,
} from '../services/multiMarketSelector.js';

export async function registerMultiMarketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/multi-market', async () => getMultiMarketStatus());

  app.post('/api/multi-market/start', async (request, reply) => {
    const body = (request.body || {}) as { account_id?: number; needles?: string[] };
    const accountId = Number(body.account_id);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return reply.code(400).send({ error: 'account_id required', message: 'account_id required' });
    }
    try {
      const status = await startMultiMarketSelector({
        account_id: accountId,
        needles: Array.isArray(body.needles) ? body.needles.map(String) : undefined,
      });
      return { success: true, ...status };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Start failed';
      return reply.code(400).send({ error: message, message });
    }
  });

  app.post('/api/multi-market/stop', async () => {
    return { success: true, ...stopMultiMarketSelector() };
  });

  /** Toggle client multi-market (accept selector picks on any catalog epic). */
  app.post('/api/multi-market/clients/:id/multi', async (request, reply) => {
    const { id } = request.params as { id: string };
    const clientId = Number(id);
    const body = (request.body || {}) as { enabled?: boolean };
    if (!Number.isFinite(clientId) || clientId <= 0) {
      return reply.code(400).send({ error: 'client id required', message: 'client id required' });
    }
    const enabled = body.enabled !== false;
    const { rowCount } = await pool.query(
      `UPDATE clients SET panel_multi_market = $2, updated_at = NOW() WHERE id = $1`,
      [clientId, enabled]
    );
    if (!rowCount) {
      return reply.code(404).send({ error: 'Client not found', message: 'Client not found' });
    }
    return { success: true, client_id: clientId, panel_multi_market: enabled };
  });
}
