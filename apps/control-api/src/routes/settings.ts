import { FastifyInstance } from 'fastify';

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => ({
    operating_mode: process.env.OPERATING_MODE || 'PAPER',
    live_trading_enabled: process.env.LIVE_TRADING_ENABLED === 'true',
    primary_horizon_ms: 10000,
    entry_ttl_ms: 2000,
    log_level: process.env.LOG_LEVEL || 'info',
  }));

  app.put('/api/settings', async (request) => {
    const body = request.body as { log_level?: string };
    if (body.log_level) {
      process.env.LOG_LEVEL = body.log_level;
    }
    return { success: true };
  });
}
