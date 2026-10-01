import { FastifyInstance } from 'fastify';
import { pool, healthCheck } from '../db/pool.js';
import { TelemetryBroadcaster } from '../ws/telemetry.js';
import { logAudit } from '../services/audit.js';
import {
  FACTORY_RESET_CONFIRM,
  factoryResetLearning,
} from '../services/factoryResetLearning.js';

function liveEnabled(): boolean {
  const v = process.env.LIVE_TRADING_ENABLED;
  if (v === undefined || v === '') return false;
  return v !== 'false' && v !== '0';
}

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
    let feedActive = 0;
    let feedUnhealthy = 0;
    let capitalSenders = 0;
    try {
      const [pos, execs, clients, brokers, markets] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS n FROM positions WHERE status = 'OPEN'`),
        pool.query(
          `SELECT COUNT(*)::int AS n FROM trades
           WHERE closed_at IS NOT NULL AND closed_at::date = CURRENT_DATE`
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

    return {
      market_core: 'HEALTHY',
      execution: 'HEALTHY',
      database: dbOk ? 'HEALTHY' : 'UNHEALTHY',
      postgres: dbOk ? 'ok' : 'down',
      redis: 'ok',
      control_api: 'HEALTHY',
      feeds: { active: feedActive, unhealthy: feedUnhealthy },
      clients: { active: clientsActive },
      brokers_live: brokersLive,
      live_brokers: brokersLive,
      capital_senders: capitalSenders,
      capital_markets: capitalMarkets,
      open_positions: openPositions,
      today_executions: todayExecutions,
      mode: process.env.OPERATING_MODE || 'PAPER',
      live_enabled: liveEnabled(),
      server_time: new Date().toISOString(),
      latency: telemetry.getLatestMetrics(),
      status: dbOk ? 'LIVE' : 'DEGRADED',
    };
  });

  app.get('/api/system/mode', async () => ({
    mode: process.env.OPERATING_MODE || 'PAPER',
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
    if (body.mode === 'LIVE' && !liveEnabled()) {
      return reply.code(403).send({
        error: 'LIVE refused — set LIVE_TRADING_ENABLED=true first',
        message: 'LIVE refused — set LIVE_TRADING_ENABLED=true first',
      });
    }
    process.env.OPERATING_MODE = body.mode;
    return { mode: body.mode, previous: prev, live_enabled: liveEnabled() };
  });

  app.get('/api/system/metrics', async () => telemetry.getLatestMetrics());

  app.get('/api/system/events', async () => {
    const { rows } = await pool.query(
      'SELECT * FROM system_events ORDER BY created_at DESC LIMIT 100'
    );
    return rows;
  });

  /**
   * Learn-from-scratch: genome/learners/auto-cal/desk Soft+Peak+Target + optional DB history.
   * KEEP Capital credentials + clients. Requires confirm: "LEARN_FROM_SCRATCH".
   */
  app.post('/api/system/factory-reset-learning', async (request, reply) => {
    const body = (request.body || {}) as {
      confirm?: string;
      wipe_db_history?: boolean;
      force_open_trades?: boolean;
      wipe_brain_history?: boolean;
    };
    try {
      const result = await factoryResetLearning({
        confirm: String(body.confirm || ''),
        wipe_db_history: body.wipe_db_history,
        force_open_trades: body.force_open_trades,
        wipe_brain_history: body.wipe_brain_history,
      });
      await logAudit('admin', 'factory_reset_learning', 'system', 'learning', null, {
        clients_reset: result.clients_reset,
        db_history_wiped: result.db_history_wiped,
        robots_stopped: result.robots_stopped,
        robots_manage_only: result.robots_manage_only,
      });
      return { success: true, ...result, confirm_phrase: FACTORY_RESET_CONFIRM };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      const code = err.statusCode || 500;
      return reply.code(code).send({
        error: err.message || 'factory reset failed',
        confirm_phrase: FACTORY_RESET_CONFIRM,
      });
    }
  });
}
