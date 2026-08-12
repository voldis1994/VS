import { FastifyInstance } from 'fastify';
import { TelemetryBroadcaster } from '../ws/telemetry.js';
import { getEnabledInstruments } from '../config/instruments.js';

function buildMarketRows() {
  const regimes = ['PULLBACK_UPTREND', 'RANGE', 'BREAKOUT', 'TREND_DOWN', 'COMPRESSION'];
  return getEnabledInstruments().map((inst, idx) => {
    const regime = regimes[idx % regimes.length];
    const pressure = Number((Math.sin(idx + 1) * 0.4 + 0.2).toFixed(2));
    return {
      instrument_id: inst.id,
      symbol: inst.symbol,
      display_name: inst.display_name,
      category: inst.category,
      regime,
      setup: regime === 'RANGE' ? null : 'CONTINUATION',
      evidence_state: regime === 'RANGE' ? null : 'BUILDING',
      direction_pressure: pressure,
      probability: Number((0.5 + Math.abs(pressure) * 0.2).toFixed(2)),
      expected_edge: Number((Math.abs(pressure) * 0.0002).toFixed(6)),
      data_quality: 0.9,
      feed_consensus: 0.85,
      entry_state: 'NO_TRADE',
      last_update: new Date().toISOString(),
    };
  });
}

export async function registerMarketRoutes(
  app: FastifyInstance,
  telemetry: TelemetryBroadcaster
): Promise<void> {
  app.get('/api/market/instruments', async () => buildMarketRows());

  app.get('/api/market/instruments/:id', async (request) => {
    const { id } = request.params as { id: string };
    const rows = buildMarketRows();
    const inst = rows.find((i) => i.instrument_id === parseInt(id, 10));
    if (!inst) return { error: 'Not found' };
    return {
      ...inst,
      market_state: {
        direction: { pressure: inst.direction_pressure, confidence: 0.7 },
        structure: { in_range: inst.regime === 'RANGE' },
        volatility: { level: 0.0003, compressed: false },
        flow: { net_flow: inst.direction_pressure },
        liquidity: { spread: 0.0001 },
        multi_feed: { consensus_confidence: inst.feed_consensus },
        data_quality: { overall_score: inst.data_quality },
      },
    };
  });

  app.get('/api/market/evidence/:instrumentId', async (request) => {
    const { instrumentId } = request.params as { instrumentId: string };
    return {
      instrument_id: parseInt(instrumentId, 10),
      setup_lifecycle: 'BUILDING',
      evidence_timeline: [],
      supporting: [],
      contradicting: [],
      evidence_strength: 0,
      trade_intent: null,
    };
  });

  app.get('/api/feeds', async () => [
    {
      source_id: 1,
      name: 'synthetic-primary',
      status: 'HEALTHY',
      latency_ms: 2.1,
      jitter_ms: 0.5,
      stale_rate: 0.001,
      sequence_gaps: 0,
      divergence: 0.00001,
      reliability: 0.99,
      predictive_score: 0.75,
      last_event: new Date().toISOString(),
    },
    {
      source_id: 2,
      name: 'synthetic-reference',
      status: 'HEALTHY',
      latency_ms: 3.4,
      jitter_ms: 0.8,
      stale_rate: 0.002,
      sequence_gaps: 0,
      divergence: 0.00002,
      reliability: 0.97,
      predictive_score: 0.68,
      last_event: new Date().toISOString(),
    },
  ]);

  setInterval(() => {
    telemetry.broadcast({
      type: 'market_update',
      instruments: buildMarketRows(),
      timestamp: new Date().toISOString(),
    });
  }, 2000);
}
