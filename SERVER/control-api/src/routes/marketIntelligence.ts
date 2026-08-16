/**
 * Market intelligence HTTP surface — measurements only, never fake LIVE prices.
 */

import type { FastifyInstance } from 'fastify';
import {
  validateMultiFeed,
  rawTickFromParts,
  buildMarketStateVector,
  evaluateTrendContinuationSetup,
  computeProtectiveStop,
  computeLotSize,
  buildTradeExplanation,
  type Candle10s,
  type RawTickEvent,
} from '../../../core/market-intelligence/src/index.js';

function authorizeAdmin(req: { headers: Record<string, unknown> }, expected?: string): boolean {
  const want = String(expected || process.env.API_ADMIN_TOKEN || '').trim();
  if (!want || want === 'CHANGE_ME_ADMIN_TOKEN') {
    return process.env.NODE_ENV !== 'production';
  }
  return String(req.headers['x-admin-token'] || '').trim() === want;
}

export async function registerMarketIntelligenceRoutes(
  app: FastifyInstance,
  deps: { adminToken?: string } = {}
): Promise<void> {
  const token = deps.adminToken ?? process.env.API_ADMIN_TOKEN;

  /** Multi-feed validation — body must supply real ticks; server never invents them. */
  app.post('/api/v1/market/feeds/validate', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    const body = (req.body || {}) as {
      instrument?: string;
      ticks?: Array<Partial<RawTickEvent> & { bid?: number; ask?: number; provider?: string }>;
      expectedProviders?: string[];
    };
    if (!body.instrument || !Array.isArray(body.ticks)) {
      return reply.code(400).send({ ok: false, code: 'INVALID_BODY', detail: 'instrument + ticks required' });
    }
    const ticks: RawTickEvent[] = [];
    for (const t of body.ticks) {
      const built = rawTickFromParts({
        provider: String(t.provider || ''),
        instrument: body.instrument,
        bid: Number(t.bid),
        ask: Number(t.ask),
        timestamp_source: String(t.timestamp_source || new Date().toISOString()),
        timestamp_receive: t.timestamp_receive ? String(t.timestamp_receive) : undefined,
        sequence_id: t.sequence_id ?? null,
        source_quality: t.source_quality,
      });
      if (built) ticks.push(built);
    }
    if (ticks.length === 0) {
      return {
        ok: true,
        report: validateMultiFeed({
          instrument: body.instrument,
          ticks: [],
          expectedProviders: body.expectedProviders,
        }),
      };
    }
    return {
      ok: true,
      report: validateMultiFeed({
        instrument: body.instrument,
        ticks,
        expectedProviders: body.expectedProviders,
      }),
    };
  });

  /** Market state vector from closed 10s candles (client supplies candles from store). */
  app.post('/api/v1/market/state', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    const body = (req.body || {}) as {
      instrument?: string;
      as_of?: string;
      candles?: Candle10s[];
      feed_confidence?: number | null;
      spread_quality?: number | null;
    };
    if (!body.instrument || !Array.isArray(body.candles)) {
      return reply.code(400).send({ ok: false, code: 'INVALID_BODY' });
    }
    const asOf = body.as_of || new Date().toISOString();
    const vector = buildMarketStateVector({
      instrument: body.instrument,
      candles: body.candles,
      asOf,
      feedConfidence: body.feed_confidence ?? null,
      spreadQuality: body.spread_quality ?? null,
    });
    return { ok: true, vector };
  });

  /** Evaluate trend_continuation setup with PASS/FAIL conditions. */
  app.post('/api/v1/market/setup/trend_continuation', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    const body = (req.body || {}) as {
      vector?: ReturnType<typeof buildMarketStateVector>;
      feed_quality?: 'OK' | 'DEGRADED' | 'BLOCK' | 'INSUFFICIENT_DATA';
      trading_price?: number | null;
      feed_detail?: string;
      structure_invalidation?: number | null;
      atr?: number | null;
      lot?: number;
      instrument_spec?: { min_lot: number; max_lot: number; lot_step: number };
    };
    if (!body.vector) {
      return reply.code(400).send({ ok: false, code: 'INVALID_BODY', detail: 'vector required' });
    }
    const setup = evaluateTrendContinuationSetup({
      market: body.vector,
      feed: {
        quality: body.feed_quality || 'INSUFFICIENT_DATA',
        trading_price: body.trading_price ?? null,
        block: null,
        detail: body.feed_detail || '',
      },
    });

    let sl = null;
    let lot = null;
    let explanation = null;
    if (setup.all_pass && setup.direction && setup.entry_reference != null) {
      sl = computeProtectiveStop({
        direction: setup.direction,
        entry: setup.entry_reference,
        structureLevel: body.structure_invalidation ?? null,
        atr: body.atr ?? body.vector.inputs.atr,
      });
      lot = computeLotSize({
        policy: { mode: 'FIXED', lot: body.lot ?? 0.1 },
        instrument: body.instrument_spec || { min_lot: 0.01, max_lot: 10, lot_step: 0.01 },
      });
      explanation = buildTradeExplanation({
        trade_id: setup.setup_id,
        setup,
        market: body.vector,
        sl,
        lot,
      });
    }

    return {
      ok: true,
      setup,
      protective_stop: sl,
      lot,
      explanation,
      // Honest operational note when blocked
      trading_allowed: Boolean(setup.all_pass && sl && 'ok' in sl && sl.ok && lot && lot.ok),
    };
  });
}
