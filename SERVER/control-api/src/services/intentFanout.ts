import { pool } from '../db/pool.js';
import {
  listActiveSubscriptionsForEpic,
  noteBrokerError,
  type ActiveSubscription,
} from './clientSubscriptions.js';
import { notePipelineRegime } from './regimes.js';
import { listRunningHandsForEpic, offerCalcEntry } from './robotDesk.js';

export { stopEntryRobotsForAccount } from './robotDesk.js';

export type PipelineIntentInput = {
  epic: string;
  direction: 'BUY' | 'SELL';
  instrument_id?: number | null;
  setup_id?: number | null;
  setup_type?: string | null;
  regime?: string | null;
  reference_price?: number | null;
  decision?: string;
  explanation?: string | null;
  reason_codes?: unknown;
  /** Stable id from Market Reader — prevents double execution on transport retry */
  idempotency_key?: string | null;
};

export type FanoutResult = {
  epic: string;
  direction: 'BUY' | 'SELL';
  setup_type: string | null;
  regime: string | null;
  subscribers: number;
  executed: Array<{
    client_id: number;
    account_id: number;
    lot_size: number;
    ok: boolean;
    detail: string;
    entry_price: number | null;
  }>;
};

/**
 * ExecutionRouter equivalent (Node): EntryReady intent → subscribed RUNNING clients only.
 * Lot size from each subscription. No decision logic here.
 * Broker opens stay on robotDesk durable path. Calc (C++ pipeline) queues EntryReady
 * onto the running robot — it does not SKIP and does not open Capital itself.
 */
export async function executePipelineIntent(
  intent: PipelineIntentInput
): Promise<FanoutResult> {
  const epic = String(intent.epic || '').trim();
  const direction = intent.direction === 'SELL' ? 'SELL' : 'BUY';
  const setupType = intent.setup_type ? String(intent.setup_type) : null;
  const regime = intent.regime ? String(intent.regime) : null;
  if (!epic) throw new Error('epic required');
  if (regime) notePipelineRegime(epic, regime);
  if (intent.decision && String(intent.decision).toUpperCase() !== 'ENTRY_READY') {
    throw new Error('Only EntryReady intents are executable');
  }

  const idem =
    intent.idempotency_key && String(intent.idempotency_key).trim()
      ? String(intent.idempotency_key).trim().slice(0, 190)
      : null;

  const subs = await listActiveSubscriptionsForEpic(epic);
  const executed: FanoutResult['executed'] = [];
  const seenAccounts = new Set<number>();

  for (const sub of subs) {
    const row = await executeForSubscription(
      sub,
      direction,
      setupType,
      regime,
      intent.reference_price,
      idem,
      intent.explanation ?? null
    );
    executed.push(row);
    seenAccounts.add(sub.account_id);
  }

  for (const hand of listRunningHandsForEpic(epic)) {
    if (seenAccounts.has(hand.account_id)) continue;
    const queued = offerCalcEntry({
      account_id: hand.account_id,
      epic,
      direction,
      setup_type: setupType,
      regime,
      explanation: intent.explanation ?? null,
      reference_price: intent.reference_price ?? null,
      idempotency_key: idem,
    });
    executed.push({
      client_id: hand.client_id,
      account_id: hand.account_id,
      lot_size: 0,
      ok: true,
      detail: queued.running
        ? 'QUEUED · robotDesk will execute calc EntryReady'
        : 'QUEUED · START robot to execute calc EntryReady',
      entry_price: null,
    });
    seenAccounts.add(hand.account_id);
  }

  return {
    epic,
    direction,
    setup_type: setupType,
    regime,
    subscribers: executed.length,
    executed,
  };
}

type ExecRow = FanoutResult['executed'][number];

/** Claim execution slot once per (idempotency_key, client, account). Concurrent-safe. */
async function claimExecution(
  idem: string,
  clientId: number,
  accountId: number
): Promise<'acquired' | 'duplicate'> {
  const ins = await pool.query(
    `INSERT INTO pipeline_execution_claims
       (idempotency_key, client_id, account_id, status)
     VALUES ($1, $2, $3, 'claimed')
     ON CONFLICT (idempotency_key, client_id, account_id) DO NOTHING
     RETURNING client_id`,
    [idem, clientId, accountId]
  );
  return ins.rows.length ? 'acquired' : 'duplicate';
}

async function completeExecutionClaim(
  idem: string,
  clientId: number,
  accountId: number,
  summary: ExecRow
): Promise<void> {
  await pool.query(
    `UPDATE pipeline_execution_claims
     SET status = 'completed', result_summary = $4, completed_at = NOW()
     WHERE idempotency_key = $1 AND client_id = $2 AND account_id = $3`,
    [idem, clientId, accountId, JSON.stringify(summary)]
  );
}

async function executeForSubscription(
  sub: ActiveSubscription,
  direction: 'BUY' | 'SELL',
  setupType: string | null,
  regime: string | null,
  referencePrice: number | null | undefined,
  idempotencyKey: string | null,
  explanation: string | null
): Promise<ExecRow> {
  let claimed = false;
  const finish = async (row: ExecRow): Promise<ExecRow> => {
    if (claimed && idempotencyKey) {
      try {
        await completeExecutionClaim(idempotencyKey, sub.client_id, sub.account_id, row);
      } catch {
        /* best-effort */
      }
    }
    return row;
  };

  try {
    const own = await pool.query(
      `SELECT ba.id
       FROM broker_accounts ba
       JOIN broker_connections bc ON bc.id = ba.broker_connection_id
       WHERE ba.id = $1 AND bc.client_id = $2 AND ba.enabled = true AND bc.enabled = true`,
      [sub.account_id, sub.client_id]
    );
    if (!own.rows.length) {
      return finish({
        client_id: sub.client_id,
        account_id: sub.account_id,
        lot_size: sub.lot_size,
        ok: false,
        detail: 'Account ownership check failed',
        entry_price: null,
      });
    }

    if (idempotencyKey) {
      const claim = await claimExecution(idempotencyKey, sub.client_id, sub.account_id);
      if (claim === 'duplicate') {
        const prev = await pool.query(
          `SELECT status, result_summary FROM pipeline_execution_claims
           WHERE idempotency_key = $1 AND client_id = $2 AND account_id = $3`,
          [idempotencyKey, sub.client_id, sub.account_id]
        );
        const summary = prev.rows[0]?.result_summary as ExecRow | undefined;
        if (summary && typeof summary === 'object' && 'ok' in summary) {
          return summary;
        }
        return {
          client_id: sub.client_id,
          account_id: sub.account_id,
          lot_size: sub.lot_size,
          ok: false,
          detail: 'Duplicate intent — already processed',
          entry_price: null,
        };
      }
      claimed = true;
    }

    const queued = offerCalcEntry({
      account_id: sub.account_id,
      epic: sub.epic,
      direction,
      setup_type: setupType,
      regime,
      explanation,
      reference_price: referencePrice ?? null,
      idempotency_key: idempotencyKey,
    });
    return finish({
      client_id: sub.client_id,
      account_id: sub.account_id,
      lot_size: sub.lot_size,
      ok: true,
      detail: queued.running
        ? 'QUEUED · robotDesk will execute calc EntryReady'
        : 'QUEUED · START robot to execute calc EntryReady',
      entry_price: null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    noteBrokerError(sub.client_id, detail);
    return finish({
      client_id: sub.client_id,
      account_id: sub.account_id,
      lot_size: sub.lot_size,
      ok: false,
      detail,
      entry_price: null,
    });
  }
}

export async function ingestAndExecuteIntent(
  intent: PipelineIntentInput
): Promise<{ intent_id: number | null; fanout: FanoutResult; deduped?: boolean }> {
  const idem =
    intent.idempotency_key && String(intent.idempotency_key).trim()
      ? String(intent.idempotency_key).trim().slice(0, 190)
      : null;

  // Claim intent slot early (before Capital) so concurrent HTTP retries share one fanout
  if (idem) {
    const claimed = await pool.query(
      `INSERT INTO pipeline_intent_dedupe (idempotency_key, fanout_summary)
       VALUES ($1, NULL)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [idem]
    );
    if (!claimed.rows.length) {
      for (let i = 0; i < 20; i++) {
        const existing = await pool.query(
          `SELECT fanout_summary FROM pipeline_intent_dedupe WHERE idempotency_key = $1`,
          [idem]
        );
        const prev = existing.rows[0]?.fanout_summary as FanoutResult | null;
        if (prev && typeof prev === 'object' && Array.isArray(prev.executed)) {
          return { intent_id: null, fanout: prev, deduped: true };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        intent_id: null,
        fanout: {
          epic: String(intent.epic || ''),
          direction: intent.direction === 'SELL' ? 'SELL' : 'BUY',
          setup_type: intent.setup_type ? String(intent.setup_type) : null,
          regime: intent.regime ? String(intent.regime) : null,
          subscribers: 0,
          executed: [],
        },
        deduped: true,
      };
    }
  }

  let intentId: number | null = null;
  try {
    const ins = await pool.query(
      `INSERT INTO trade_intents
         (setup_id, instrument_id, direction, decision, reference_price,
          explanation, reason_codes, epic, setup_type, regime, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING')
       RETURNING id`,
      [
        intent.setup_id ?? 0,
        intent.instrument_id ?? 0,
        intent.direction,
        intent.decision || 'ENTRY_READY',
        intent.reference_price ?? null,
        intent.explanation ?? null,
        intent.reason_codes ? JSON.stringify(intent.reason_codes) : null,
        intent.epic,
        intent.setup_type ?? null,
        intent.regime ?? null,
      ]
    );
    intentId = Number(ins.rows[0].id);
  } catch {
    intentId = null;
  }

  const fanout = await executePipelineIntent(intent);

  if (intentId != null) {
    await pool.query(
      `UPDATE trade_intents SET status = 'PROCESSED', processed_at = NOW() WHERE id = $1`,
      [intentId]
    );
  }

  if (idem) {
    try {
      await pool.query(
        `UPDATE pipeline_intent_dedupe
         SET fanout_summary = $2
         WHERE idempotency_key = $1`,
        [idem, JSON.stringify(fanout)]
      );
    } catch {
      /* ignore */
    }
  }

  return { intent_id: intentId, fanout };
}

/** Alias matching Client Panel docs / E2E trace naming. */
export const fanoutEntryIntent = ingestAndExecuteIntent;

/** Pure routing helper for tests — mirrors ExecutionRouter filters. */
export function routeIntentToSubscriptions(
  intentEpic: string,
  subscriptions: Array<{ client_id: number; epic: string; running: boolean; lot_size: number }>
): Array<{ client_id: number; lot_size: number }> {
  const epic = intentEpic.trim().toUpperCase();
  return subscriptions
    .filter((s) => s.running && s.epic.trim().toUpperCase() === epic)
    .map((s) => ({ client_id: s.client_id, lot_size: s.lot_size }));
}
