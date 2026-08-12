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
    return {
      market_core: 'HEALTHY',
      execution: 'HEALTHY',
      database: dbOk ? 'HEALTHY' : 'UNHEALTHY',
      control_api: 'HEALTHY',
      feeds: { active: 2, unhealthy: 0 },
      clients: { active: 0 },
      open_positions: 0,
      today_executions: 0,
      mode: process.env.OPERATING_MODE || 'PAPER',
      latency: telemetry.getLatestMetrics(),
    };
  });

  app.get('/api/system/mode', async () => ({
    mode: process.env.OPERATING_MODE || 'PAPER',
    live_enabled: process.env.LIVE_TRADING_ENABLED === 'true',
  }));

  app.post('/api/system/mode', async (request) => {
    const body = request.body as { mode: string };
    const prev = process.env.OPERATING_MODE;
    if (body.mode === 'LIVE' && process.env.LIVE_TRADING_ENABLED !== 'true') {
      return { error: 'LIVE mode requires LIVE_TRADING_ENABLED=true' };
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
