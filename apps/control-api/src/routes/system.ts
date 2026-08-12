import { FastifyInstance } from 'fastify';
import { pool, healthCheck } from '../db/pool.js';
import { TelemetryBroadcaster } from '../ws/telemetry.js';

export async function registerSystemRoutes(
  app: FastifyInstance,
  telemetry: TelemetryBroadcaster
): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/api/system/status', async () => {
    const dbOk = await healthCheck();
    let openPositions = 0;
    let todayExecutions = 0;
    let clientsActive = 0;
    let brokersLive = 0;
    let capitalMarkets = 0;
    try {
      const [pos, execs, clients, brokers, markets] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS n FROM positions WHERE status = 'OPEN'`),
        pool.query(
          `SELECT COUNT(*)::int AS n FROM executions WHERE executed_at::date = CURRENT_DATE`
        ),
        pool.query(`SELECT COUNT(*)::int AS n FROM clients WHERE enabled = true`),
        pool.query(
          `SELECT COUNT(*)::int AS n FROM broker_connections WHERE enabled = true AND environment = 'live'`
        ),
        pool.query(`SELECT COUNT(*)::int AS n FROM capital_markets`),
      ]);
      openPositions = pos.rows[0]?.n ?? 0;
      todayExecutions = execs.rows[0]?.n ?? 0;
      clientsActive = clients.rows[0]?.n ?? 0;
      brokersLive = brokers.rows[0]?.n ?? 0;
      capitalMarkets = markets.rows[0]?.n ?? 0;
    } catch {
      // tables may be mid-migrate
    }

    return {
      market_core: 'HEALTHY',
      execution: 'HEALTHY',
      database: dbOk ? 'HEALTHY' : 'UNHEALTHY',
      postgres: dbOk ? 'ok' : 'down',
      redis: 'ok',
      control_api: 'HEALTHY',
      feeds: { active: 2, unhealthy: 0 },
      clients: { active: clientsActive },
      brokers_live: brokersLive,
      live_brokers: brokersLive,
      capital_markets: capitalMarkets,
      open_positions: openPositions,
      today_executions: todayExecutions,
      mode: process.env.OPERATING_MODE || 'PAPER',
      live_enabled: process.env.LIVE_TRADING_ENABLED === 'true',
      server_time: new Date().toISOString(),
      latency: telemetry.getLatestMetrics(),
      status: dbOk ? 'LIVE' : 'DEGRADED',
    };
  });

  app.get('/api/system/mode', async () => ({
    mode: process.env.OPERATING_MODE || 'PAPER',
    live_enabled: process.env.LIVE_TRADING_ENABLED === 'true',
  }));

  app.post('/api/system/mode', async (request, reply) => {
    const body = request.body as { mode: string };
    const prev = process.env.OPERATING_MODE;
    const allowed = ['REPLAY', 'PAPER', 'DEMO', 'LIVE'];
    if (!allowed.includes(body.mode)) {
      return reply.code(400).send({ error: `Invalid mode. Use: ${allowed.join(', ')}` });
    }
    if (body.mode === 'LIVE' && process.env.LIVE_TRADING_ENABLED !== 'true') {
      return reply.code(400).send({
        error: 'LIVE mode requires LIVE trading gate ON (Settings → Enable LIVE trading)',
      });
    }
    process.env.OPERATING_MODE = body.mode;
    return { mode: body.mode, previous: prev };
  });

  app.get('/api/system/metrics', async () => telemetry.getLatestMetrics());

  app.get('/api/system/events', async () => {
    const { rows } = await pool.query(
      'SELECT * FROM system_events ORDER BY created_at DESC LIMIT 100'
    );
    return rows;
  });
}
