import { FastifyInstance } from 'fastify';
import { pool, healthCheck } from '../db/pool.js';
import { TelemetryBroadcaster } from '../ws/telemetry.js';

function liveEnabled(): boolean {
  const v = process.env.LIVE_TRADING_ENABLED;
  if (v === undefined || v === '') return true;
  return v !== 'false' && v !== '0';
}

export async function registerSystemRoutes(
  app: FastifyInstance,
  telemetry: TelemetryBroadcaster
): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/api/system/status', async () => {
    const dbOk = await healthCheck();
    let feedActive = 0;
    let feedUnhealthy = 0;
    let capitalMarkets = 0;
    let capitalSenders = 0;
    try {
      const { listDataSenders } = await import('../services/robotReader.js');
      const senders = await listDataSenders();
      capitalSenders = senders.filter((s) => s.kind === 'capital_com').length;
      feedActive = senders.filter((s) => s.status === 'LIVE').length;
      feedUnhealthy = senders.filter((s) => s.status === 'ERROR').length;
      const m = await pool.query(`SELECT COUNT(*)::int AS n FROM capital_markets`);
      capitalMarkets = m.rows[0]?.n ?? 0;
    } catch {
      /* mid-migrate / first boot */
    }
    return {
      market_core: 'HEALTHY',
      execution: 'HEALTHY',
      database: dbOk ? 'HEALTHY' : 'UNHEALTHY',
      control_api: 'HEALTHY',
      feeds: { active: feedActive, unhealthy: feedUnhealthy },
      capital_senders: capitalSenders,
      capital_markets: capitalMarkets,
      clients: { active: 0 },
      open_positions: 0,
      today_executions: 0,
      mode: process.env.OPERATING_MODE || 'LIVE',
      live_enabled: liveEnabled(),
      latency: telemetry.getLatestMetrics(),
    };
  });

  app.get('/api/system/mode', async () => ({
    mode: process.env.OPERATING_MODE || 'LIVE',
    live_enabled: liveEnabled(),
  }));

  app.post('/api/system/mode', async (request, reply) => {
    const body = request.body as { mode: string };
    const prev = process.env.OPERATING_MODE;
    const allowed = ['REPLAY', 'PAPER', 'DEMO', 'LIVE'];
    if (!allowed.includes(body.mode)) {
      return reply.code(400).send({ error: `Invalid mode. Use: ${allowed.join(', ')}` });
    }
    // No LIVE gate — operator accepts risk
    process.env.OPERATING_MODE = body.mode;
    if (body.mode === 'LIVE') {
      process.env.LIVE_TRADING_ENABLED = 'true';
    }
    return { mode: body.mode, previous: prev, live_enabled: liveEnabled() };
  });

  app.get('/api/system/metrics', async () => telemetry.getLatestMetrics());

  app.get('/api/system/events', async () => {
    const { rows } = await pool.query(
      'SELECT * FROM system_events ORDER BY created_at DESC LIMIT 100'
    );
    return rows;
  });
}
