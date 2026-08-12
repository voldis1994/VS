import { FastifyInstance } from 'fastify';
import { ingestAndExecuteIntent, routeIntentToSubscriptions } from '../services/intentFanout.js';

/**
 * Pipeline intent ingest — admin/internal only (x-admin-token).
 * Client Panel never invents intents; market-core / operators publish EntryReady here.
 */
export async function registerPipelineRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/pipeline/intents', async (request, reply) => {
    const body = (request.body || {}) as {
      epic?: string;
      direction?: string;
      instrument_id?: number;
      setup_id?: number;
      setup_type?: string | null;
      reference_price?: number | null;
      decision?: string;
      explanation?: string | null;
      reason_codes?: unknown;
      // Ignore any client_id spoofing
      client_id?: unknown;
    };

    if (body.client_id != null) {
      // Explicitly ignore — routing is subscription-based only
    }

    const epic = String(body.epic || '').trim();
    const directionRaw = String(body.direction || '').toUpperCase();
    const direction = directionRaw === 'SELL' || directionRaw === 'SHORT' ? 'SELL' : null;
    const buy = directionRaw === 'BUY' || directionRaw === 'LONG' ? 'BUY' : null;
    if (!epic || (!direction && !buy)) {
      return reply.code(400).send({
        error: 'epic and direction (BUY|SELL) required',
        message: 'epic and direction (BUY|SELL) required',
      });
    }

    try {
      const result = await ingestAndExecuteIntent({
        epic,
        direction: (buy || direction) as 'BUY' | 'SELL',
        instrument_id: body.instrument_id ?? null,
        setup_id: body.setup_id ?? null,
        setup_type: body.setup_type ?? null,
        reference_price: body.reference_price ?? null,
        decision: body.decision || 'ENTRY_READY',
        explanation: body.explanation ?? null,
        reason_codes: body.reason_codes,
      });
      return { success: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Intent failed';
      return reply.code(400).send({ error: message, message });
    }
  });

  /** Test helper documentation endpoint — routing preview without execution */
  app.post('/api/pipeline/route-preview', async (request, reply) => {
    const body = (request.body || {}) as {
      epic?: string;
      subscriptions?: Array<{
        client_id: number;
        epic: string;
        running: boolean;
        lot_size: number;
      }>;
    };
    if (!body.epic || !Array.isArray(body.subscriptions)) {
      return reply.code(400).send({ error: 'epic and subscriptions required' });
    }
    return {
      matched: routeIntentToSubscriptions(body.epic, body.subscriptions),
    };
  });
}
