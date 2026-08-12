import { FastifyInstance } from 'fastify';
import { logAudit } from '../services/audit.js';

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => ({
    operating_mode: process.env.OPERATING_MODE || 'PAPER',
    live_trading_enabled: process.env.LIVE_TRADING_ENABLED === 'true',
    primary_horizon_ms: 10000,
    entry_ttl_ms: 2000,
    log_level: process.env.LOG_LEVEL || 'info',
  }));

  app.put('/api/settings', async (request, reply) => {
    const body = request.body as {
      log_level?: string;
      live_trading_enabled?: boolean;
      confirm_live?: boolean;
    };

    if (body.log_level) {
      process.env.LOG_LEVEL = body.log_level;
    }

    if (typeof body.live_trading_enabled === 'boolean') {
      if (body.live_trading_enabled && !body.confirm_live) {
        return reply.code(400).send({
          error: 'Set confirm_live=true to enable LIVE trading gate',
        });
      }
      process.env.LIVE_TRADING_ENABLED = body.live_trading_enabled ? 'true' : 'false';
      await logAudit(
        'admin',
        body.live_trading_enabled ? 'live_gate_enabled' : 'live_gate_disabled',
        'settings',
        'LIVE_TRADING_ENABLED',
        null,
        { live_trading_enabled: body.live_trading_enabled }
      );
    }

    return {
      success: true,
      operating_mode: process.env.OPERATING_MODE || 'PAPER',
      live_trading_enabled: process.env.LIVE_TRADING_ENABLED === 'true',
      log_level: process.env.LOG_LEVEL || 'info',
    };
  });
}
