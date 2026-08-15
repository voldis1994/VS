import { FastifyInstance } from 'fastify';
import {
  feedsFromSenders,
  listDataSenders,
  runOrbitScan,
  suggestOrbitEpics,
} from '../services/robotReader.js';

export async function registerRobotReaderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/robot-reader/senders', async () => {
    const senders = await listDataSenders();
    return {
      senders,
      count: senders.length,
      capital_senders: senders.filter((s) => s.kind === 'capital_com').length,
      note:
        'Each enabled Capital.com broker row is a separate sender. Add multiple Brokers (Live/Demo/clients) for multi-source reads.',
    };
  });

  app.get('/api/robot-reader/epics', async (request) => {
    const q = request.query as { limit?: string; q?: string };
    const limit = q.limit ? parseInt(q.limit, 10) : 40;
    const n = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 80) : 40;
    const needle = (q.q || '').trim();
    if (!needle) return suggestOrbitEpics(n);

    const { pool } = await import('../db/pool.js');
    const { rows } = await pool.query(
      `SELECT epic, display_name, category, broker_connection_id as connection_id
       FROM (
         SELECT DISTINCT ON (epic)
                epic, display_name, category, broker_connection_id, updated_at
         FROM capital_markets
         WHERE epic ILIKE $1 OR symbol ILIKE $1 OR display_name ILIKE $1
         ORDER BY epic, updated_at DESC
       ) t
       ORDER BY display_name ASC
       LIMIT $2`,
      [`%${needle}%`, n]
    );
    return rows.map((r) => ({
      epic: r.epic as string,
      display_name: r.display_name as string,
      category: r.category as string,
      connection_id: r.connection_id as number,
    }));
  });

  app.get('/api/robot-reader/scan', async (request, reply) => {
    const q = request.query as { epics?: string };
    const epics = (q.epics || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (epics.length === 0) {
      const suggestions = await suggestOrbitEpics(4);
      if (suggestions.length === 0) {
        return reply.code(400).send({
          error:
            'No epics to scan. Pull Capital.com markets first (Trading → Pull ALL), or pass ?epics=EURUSD,XAUUSD',
          message:
            'No epics to scan. Pull Capital.com markets first (Trading → Pull ALL), or pass ?epics=EURUSD,XAUUSD',
        });
      }
      return runOrbitScan(suggestions.map((s) => s.epic));
    }
    return runOrbitScan(epics);
  });

  app.post('/api/robot-reader/scan', async (request, reply) => {
    const body = (request.body || {}) as { epics?: string[] };
    const epics = Array.isArray(body.epics) ? body.epics : [];
    if (epics.length === 0) {
      return reply.code(400).send({
        error: 'Body must include epics: string[]',
        message: 'Body must include epics: string[]',
      });
    }
    return runOrbitScan(epics);
  });
}

/** Shared helper so /api/feeds can surface real senders instead of synthetic stubs. */
export async function listFeedHealthRows() {
  const senders = await listDataSenders();
  return feedsFromSenders(senders);
}
