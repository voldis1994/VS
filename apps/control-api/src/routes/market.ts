import { FastifyInstance } from 'fastify';
import { TelemetryBroadcaster } from '../ws/telemetry.js';

const mockInstruments = [
  {
    instrument_id: 1,
    symbol: 'EURUSD',
    regime: 'PULLBACK_UPTREND',
    setup: 'CONTINUATION',
    evidence_state: 'BUILDING',
    direction_pressure: 0.65,
    probability: 0.58,
    expected_edge: 0.00012,
    data_quality: 0.92,
    feed_consensus: 0.88,
    entry_state: 'NO_TRADE',
    last_update: new Date().toISOString(),
  },
  {
    instrument_id: 2,
    symbol: 'GBPUSD',
    regime: 'RANGE',
    setup: null,
    evidence_state: null,
    direction_pressure: 0.1,
    probability: 0.5,
    expected_edge: 0,
    data_quality: 0.95,
    feed_consensus: 0.91,
    entry_state: 'NO_TRADE',
    last_update: new Date().toISOString(),
  },
];

export async function registerMarketRoutes(
  app: FastifyInstance,
  telemetry: TelemetryBroadcaster
): Promise<void> {
  app.get('/api/market/instruments', async () => mockInstruments);

  app.get('/api/market/instruments/:id', async (request) => {
    const { id } = request.params as { id: string };
    const inst = mockInstruments.find((i) => i.instrument_id === parseInt(id, 10));
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
      instruments: mockInstruments,
      timestamp: new Date().toISOString(),
    });
  }, 2000);
}
