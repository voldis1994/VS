import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { fanoutEntryIntent, routeIntentToSubscriptions } from '../services/intentFanout.js';
import { parseRegimeFromExplanation } from '../services/regimes.js';
import {
  authorizePipelineRequest,
  getPipelineBridgeStatus,
  notePipelineBridgeError,
  notePipelineHeartbeat,
} from '../services/pipelineBridge.js';

function requirePipelineAuth(
  request: { headers: Record<string, unknown> },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } }
): boolean {
  if (authorizePipelineRequest(request.headers as Record<string, unknown>)) return true;
  reply.code(401).send({
    error: 'Unauthorized',
    message: 'Pipeline requires x-pipeline-token',
  });
  return false;
}

/**
 * INTERNAL service routes — Market Core only (x-pipeline-token).
 * Never accept client session or admin browser as Market Core identity.
 */
export async function registerPipelineRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/pipeline/subscribed-epics', async (request, reply) => {
    if (!requirePipelineAuth(request, reply)) return;
    const { rows } = await pool.query(
      `SELECT DISTINCT c.panel_epic as epic, c.panel_display_name as display_name
       FROM clients c
       WHERE c.enabled = true
         AND c.access_enabled = true
         AND c.panel_robot_requested = 'RUNNING'
         AND c.panel_epic IS NOT NULL
         AND length(trim(c.panel_epic)) > 0
       ORDER BY epic ASC`
    );
    return {
      epics: rows.map((r) => ({
        epic: String(r.epic),
        display_name: r.display_name ? String(r.display_name) : String(r.epic),
      })),
      bridge: getPipelineBridgeStatus(),
    };
  });

  app.post('/api/pipeline/heartbeat', async (request, reply) => {
    if (!requirePipelineAuth(request, reply)) return;
    const body = (request.body || {}) as { epics?: string[]; error?: string };
    if (body.error) notePipelineBridgeError(String(body.error));
    notePipelineHeartbeat(Array.isArray(body.epics) ? body.epics.map(String) : []);
    return { success: true, bridge: getPipelineBridgeStatus() };
  });

  app.get('/api/pipeline/bridge-status', async (request, reply) => {
    if (!requirePipelineAuth(request, reply)) return;
    return getPipelineBridgeStatus();
  });

  app.post('/api/pipeline/intents', async (request, reply) => {
    // Auth FIRST — never reach fanout without valid service token
    if (!requirePipelineAuth(request, reply)) return;
    const body = (request.body || {}) as {
      epic?: string;
      direction?: string;
      instrument_id?: number;
      setup_id?: number;
      setup_type?: string | null;
      regime?: string | null;
      reference_price?: number | null;
      decision?: string;
      explanation?: string | null;
      reason_codes?: unknown;
      idempotency_key?: string;
      intent_id?: number | string;
      client_id?: unknown;
    };

    // Ignore spoofed client_id — routing is subscription-based only
    void body.client_id;

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

    const idem =
      body.idempotency_key ||
      (body.intent_id != null ? `mr-intent-${body.intent_id}-${epic}` : null);

    try {
      const result = await fanoutEntryIntent({
        epic,
        direction: (buy || direction) as 'BUY' | 'SELL',
        instrument_id: body.instrument_id ?? null,
        setup_id: body.setup_id ?? null,
        setup_type: body.setup_type ?? null,
        regime: body.regime || parseRegimeFromExplanation(body.explanation ?? null),
        reference_price: body.reference_price ?? null,
        decision: body.decision || 'ENTRY_READY',
        explanation: body.explanation ?? null,
        reason_codes: body.reason_codes,
        idempotency_key: idem,
      });
      return { success: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Intent failed';
      return reply.code(400).send({ error: message, message });
    }
  });

  app.post('/api/pipeline/route-preview', async (request, reply) => {
    if (!requirePipelineAuth(request, reply)) return;
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
