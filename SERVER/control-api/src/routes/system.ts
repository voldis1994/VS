import { FastifyInstance } from 'fastify';
import { pool, healthCheck } from '../db/pool.js';
import { TelemetryBroadcaster } from '../ws/telemetry.js';
import { runtimeBuildInfo } from '../services/runtimeBuild.js';
import { buildSystemHealth } from '../services/systemHealth.js';
import { getPrimaryRobotConnectionId } from '../services/robotDesk.js';

function liveEnabled(): boolean {
  const v = process.env.LIVE_TRADING_ENABLED;
  // FAIL CLOSED: unset/empty = LIVE off
  if (v === undefined || v === '') return false;
  return v === 'true' || v === '1';
}

export async function registerSystemRoutes(
  app: FastifyInstance,
  telemetry: TelemetryBroadcaster
): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', ...runtimeBuildInfo() }));

  app.get('/api/system/health', async () => {
    return buildSystemHealth({ primaryConnectionId: getPrimaryRobotConnectionId() });
  });

  app.get('/api/system/status', async () => {
    const dbOk = await healthCheck();
    // Redis: real TCP probe — never hardcode ok
    let redisOk: boolean | null = null;
    try {
      const { createConnection } = await import('net');
      redisOk = await new Promise<boolean>((resolve) => {
        const port = Number(process.env.REDIS_PORT || 6379);
        const sock = createConnection({ host: '127.0.0.1', port });
        const done = (ok: boolean) => {
          try {
            sock.destroy();
          } catch {
            /* ignore */
          }
          resolve(ok);
        };
        sock.setTimeout(800);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
      });
    } catch {
      redisOk = null;
    }
    let openPositions = 0;
    let todayExecutions = 0;
    let clientsActive = 0;
    let brokersLive = 0;
    let capitalMarkets = 0;
    let feedActive = 0;
    let feedUnhealthy = 0;
    let capitalSenders = 0;
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
    try {
      const { listDataSenders } = await import('../services/robotReader.js');
      const senders = await listDataSenders();
      capitalSenders = senders.filter((s) => s.kind === 'capital_com').length;
      feedActive = senders.filter((s) => s.status === 'LIVE').length;
      feedUnhealthy = senders.filter((s) => s.status === 'ERROR').length;
    } catch {
      /* robot reader optional on first boot */
    }

    // Do not invent HEALTHY for market/execution — unknown until proven via monitor/snapshot
    return {
      market_core: 'UNKNOWN',
      execution: 'UNKNOWN',
      database: dbOk ? 'HEALTHY' : 'UNHEALTHY',
      postgres: dbOk ? 'ok' : 'down',
      redis: redisOk === true ? 'ok' : redisOk === false ? 'down' : 'unknown',
      control_api: 'HEALTHY',
      feeds: { active: feedActive, unhealthy: feedUnhealthy },
      clients: { active: clientsActive },
      brokers_live: brokersLive,
      live_brokers: brokersLive,
      capital_senders: capitalSenders,
      capital_markets: capitalMarkets,
      open_positions: openPositions,
      today_executions: todayExecutions,
      mode: process.env.OPERATING_MODE || 'DEMO',
      live_enabled: liveEnabled(),
      server_time: new Date().toISOString(),
      latency: telemetry.getLatestMetrics(),
      status: dbOk ? (liveEnabled() ? 'LIVE' : 'DEMO') : 'DEGRADED',
      ...runtimeBuildInfo(),
    };
  });

  app.get('/api/system/mode', async () => ({
    mode: process.env.OPERATING_MODE || 'DEMO',
    live_enabled: liveEnabled(),
    allowed: ['REPLAY', 'PAPER', 'DEMO', 'LIVE'],
  }));

  app.post('/api/system/mode', async (request, reply) => {
    const body = request.body as { mode: string };
    const prev = process.env.OPERATING_MODE;
    const allowed = ['REPLAY', 'PAPER', 'DEMO', 'LIVE'];
    if (!allowed.includes(body.mode)) {
      return reply.code(400).send({ error: `Invalid mode. Use: ${allowed.join(', ')}` });
    }
    // B7: ordinary ADMIN API cannot enable LIVE money execution
    if (body.mode === 'LIVE') {
      return reply.code(403).send({
        error: 'LIVE_ENABLE_DENIED',
        message:
          'LIVE mode cannot be enabled via /api/system/mode — set LIVE_TRADING_ENABLED only via controlled process environment + restart with safe secrets',
      });
    }
    process.env.OPERATING_MODE = body.mode;
    if (body.mode !== 'LIVE') {
      process.env.LIVE_TRADING_ENABLED = 'false';
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
