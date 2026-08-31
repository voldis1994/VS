import { FastifyInstance } from 'fastify';
import { TelemetryBroadcaster } from '../ws/telemetry.js';
import { listFeedHealthRows } from './robotReader.js';
import { listRobotSessions } from '../services/robotDesk.js';
import {
  REGIME_NAMES,
  OPERATING_MODES,
  TRADE_TYPE_NAMES,
  listRegimeSnapshots,
  regimeCatalog,
  currentRegime,
} from '../services/regimes.js';

/**
 * Market Reader — live regime board (real operating regimes only).
 */
export async function registerMarketRoutes(
  app: FastifyInstance,
  telemetry: TelemetryBroadcaster
): Promise<void> {
  app.get('/api/market/regimes', async () => ({
    regimes: regimeCatalog(),
    names: [...REGIME_NAMES],
    trade_types: [...TRADE_TYPE_NAMES],
    operating_modes: [...OPERATING_MODES],
  }));

  app.get('/api/market/instruments', async () => {
    const fromBook = listRegimeSnapshots();
    const robots = listRobotSessions();
    const byEpic = new Map<string, (typeof fromBook)[number]>();
    for (const row of fromBook) byEpic.set(row.epic.toUpperCase(), row);
    for (const s of robots) {
      const key = s.epic.toUpperCase();
      if (!byEpic.has(key)) {
        const snap = currentRegime(s.epic);
        byEpic.set(key, {
          epic: s.epic,
          display_name: s.display_name,
          current: (s.regime || snap?.current || 'RANGE') as (typeof REGIME_NAMES)[number],
          previous: snap?.previous || 'RANGE',
          confidence: snap?.confidence || 0,
          since: snap?.since || s.started_at,
          last_update: s.last_quote_at || new Date().toISOString(),
          last_mid: s.last_mid,
          bar_count: snap?.bar_count || 0,
        });
      }
    }
    return [...byEpic.values()].map((row, i) => ({
      instrument_id: i + 1,
      symbol: row.epic,
      display_name: row.display_name,
      epic: row.epic,
      regime: row.current,
      previous_regime: row.previous,
      setup: null,
      evidence_state: row.bar_count < 2 ? 'SEEDING' : 'LIVE',
      direction_pressure: 0,
      probability: row.confidence,
      expected_edge: 0,
      data_quality: row.bar_count >= 2 ? 1 : 0.3,
      feed_consensus: 1,
      entry_state: row.bar_count < 2 ? 'NONE' : 'CLASSIFIED',
      last_update: row.last_update,
      last_mid: row.last_mid,
      confidence: row.confidence,
    }));
  });

  app.get('/api/market/instruments/:id', async (request) => {
    const { id } = request.params as { id: string };
    const all = listRegimeSnapshots();
    const idx = parseInt(id, 10) - 1;
    const row = all[idx] || all.find((r) => r.epic === id);
    if (!row) return { error: 'Instrument not in live regime book yet' };
    return row;
  });

  app.get('/api/market/evidence/:instrumentId', async (request) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const all = listRegimeSnapshots();
    const idx = parseInt(instrumentId, 10) - 1;
    const row = all[idx] || currentRegime(instrumentId);
    return {
      instrument_id: parseInt(instrumentId, 10) || 0,
      regime: row?.current || 'RANGE',
      previous_regime: row?.previous || 'RANGE',
      setup_lifecycle: row && row.bar_count >= 2 ? 'LIVE' : 'SEEDING',
      evidence_timeline: [],
      supporting: [],
      contradicting: [],
      evidence_strength: row?.confidence || 0,
      trade_intent: null,
      catalog: [...REGIME_NAMES],
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
