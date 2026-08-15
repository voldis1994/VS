import { FastifyInstance } from 'fastify';
import { logAudit } from '../services/audit.js';

/** LIVE never defaults on — explicit true/1 only. */
function liveEnabled(): boolean {
  const v = process.env.LIVE_TRADING_ENABLED;
  if (v === undefined || v === '') return false;
  return v === 'true' || v === '1';
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => ({
    operating_mode: process.env.OPERATING_MODE || 'DEMO',
    live_trading_enabled: liveEnabled(),
    operating_modes: ['REPLAY', 'PAPER', 'DEMO', 'LIVE'],
    primary_horizon_ms: 10000,
    entry_ttl_ms: 2000,
    log_level: process.env.LOG_LEVEL || 'info',
  }));

  app.put('/api/settings', async (request) => {
    const body = request.body as {
      log_level?: string;
      live_trading_enabled?: boolean;
      operating_mode?: string;
    };

    if (body.log_level) {
      process.env.LOG_LEVEL = body.log_level;
    }

    if (typeof body.live_trading_enabled === 'boolean') {
      process.env.LIVE_TRADING_ENABLED = body.live_trading_enabled ? 'true' : 'false';
      await logAudit(
        'admin',
        body.live_trading_enabled ? 'live_enabled' : 'live_disabled',
        'settings',
        'LIVE_TRADING_ENABLED',
        null,
        { live_trading_enabled: body.live_trading_enabled }
      );
    }

    if (typeof body.operating_mode === 'string') {
      const allowed = ['REPLAY', 'PAPER', 'DEMO', 'LIVE'];
      if (allowed.includes(body.operating_mode)) {
        process.env.OPERATING_MODE = body.operating_mode;
      }
    }

    return {
      success: true,
      operating_mode: process.env.OPERATING_MODE || 'DEMO',
      live_trading_enabled: liveEnabled(),
      log_level: process.env.LOG_LEVEL || 'info',
    };
  });
}
