import { FastifyInstance } from 'fastify';
import { TelemetryBroadcaster } from '../ws/telemetry.js';
import { listFeedHealthRows } from './robotReader.js';

/**
 * Legacy market/evidence stubs removed — they always showed BUILDING / NO_TRADE
 * and never progressed. Real multi-sender reads live under /api/robot-reader/*.
 */
export async function registerMarketRoutes(
  app: FastifyInstance,
  telemetry: TelemetryBroadcaster
): Promise<void> {
  app.get('/api/market/instruments', async () => []);

  app.get('/api/market/instruments/:id', async () => ({
    error: 'Legacy market stub removed. Use Orbit Reader (/orbit) for real quotes.',
  }));

  app.get('/api/market/evidence/:instrumentId', async (request) => {
    const { instrumentId } = request.params as { instrumentId: string };
    return {
      instrument_id: parseInt(instrumentId, 10) || 0,
      setup_lifecycle: 'NONE',
      evidence_timeline: [],
      supporting: [],
      contradicting: [],
      evidence_strength: 0,
      trade_intent: null,
      note: 'Evidence engine not connected to live Capital feeds. Use Orbit Reader + Trading.',
    };
  });

  app.get('/api/feeds', async () => listFeedHealthRows());

  setInterval(() => {
    telemetry.broadcast({
      type: 'heartbeat',
      plane: 'control-api',
      timestamp: new Date().toISOString(),
    });
  }, 5000);
}
