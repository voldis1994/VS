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

  app.put('/api/settings', async (request, reply) => {
    const body = request.body as {
      log_level?: string;
      live_trading_enabled?: boolean;
      operating_mode?: string;
    };

    if (body.log_level) {
      process.env.LOG_LEVEL = body.log_level;
    }

    // B7: ordinary ADMIN settings must not enable LIVE money execution
    if (body.live_trading_enabled === true) {
      await logAudit(
        'admin',
        'live_enable_denied',
        'settings',
        'LIVE_TRADING_ENABLED',
        null,
        { attempted: true }
      );
      return reply.code(403).send({
        error: 'LIVE_ENABLE_DENIED',
        message:
          'LIVE_TRADING_ENABLED cannot be enabled via ADMIN settings API — require controlled process environment + restart with safe secrets',
        live_trading_enabled: liveEnabled(),
      });
    }

    if (body.live_trading_enabled === false) {
      process.env.LIVE_TRADING_ENABLED = 'false';
      await logAudit(
        'admin',
        'live_disabled',
        'settings',
        'LIVE_TRADING_ENABLED',
        null,
        { live_trading_enabled: false }
      );
    }

    if (typeof body.operating_mode === 'string') {
      const allowed = ['REPLAY', 'PAPER', 'DEMO', 'LIVE'];
      if (!allowed.includes(body.operating_mode)) {
        return reply.code(400).send({ error: 'Invalid operating_mode' });
      }
      if (body.operating_mode === 'LIVE') {
        return reply.code(403).send({
          error: 'LIVE_ENABLE_DENIED',
          message: 'OPERATING_MODE=LIVE cannot be set via ADMIN settings API',
        });
      }
      process.env.OPERATING_MODE = body.operating_mode;
    }

    return {
      ok: true,
      operating_mode: process.env.OPERATING_MODE || 'DEMO',
      live_trading_enabled: liveEnabled(),
    };
  });
}
