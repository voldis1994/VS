import { pool } from '../db/pool.js';
import { decrypt } from '../security/encryption.js';
import {
  acquireCapitalSession,
  createCapitalPosition,
  listCapitalOpenPositions,
  fetchCapitalMarketQuote,
  fetchCapitalMinutePrices,
  computeSafetyCushionStopLevel,
  isLateMoveOnOneMinute,
} from './capitalCom.js';
import { emitToClient } from './clientEvents.js';
import {
  listActiveSubscriptionsForEpic,
  noteBrokerError,
  noteBrokerOk,
  type ActiveSubscription,
} from './clientSubscriptions.js';
import { formatTradeLabel } from './tradePresentation.js';
import { notePipelineRegime } from './regimes.js';
import { attachManageOnlyRobot } from './robotDesk.js';

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

async function loadCreds(connectionId: number): Promise<Record<string, string>> {
  const { rows } = await pool.query(
    `SELECT credential_type, ciphertext, iv, tag
     FROM api_credential_metadata WHERE broker_connection_id = $1`,
    [connectionId]
  );
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.credential_type as string] = decrypt(
      row.ciphertext as string,
      row.iv as string,
      row.tag as string
    );
  }
  return out;
}

/**
 * ExecutionRouter equivalent (Node): EntryReady intent → subscribed RUNNING clients only.
 * Lot size from each subscription. No decision logic here.
 */
export async function executePipelineIntent(
  intent: PipelineIntentInput
): Promise<FanoutResult> {
  const epic = String(intent.epic || '').trim();
  const direction = intent.direction === 'SELL' ? 'SELL' : 'BUY';
  const setupType = intent.setup_type ? String(intent.setup_type) : null;
  const regime = intent.regime ? String(intent.regime) : null;
  if (!epic) throw new Error('epic required');
  if (regime) notePipelineRegime(epic, regime, undefined, 'pipeline');
  if (intent.decision && String(intent.decision).toUpperCase() !== 'ENTRY_READY') {
    throw new Error('Only EntryReady intents are executable');
  }

  const idem =
    intent.idempotency_key && String(intent.idempotency_key).trim()
      ? String(intent.idempotency_key).trim().slice(0, 190)
      : null;

  const subs = await listActiveSubscriptionsForEpic(epic);
  const executed: FanoutResult['executed'] = [];

  for (const sub of subs) {
    const row = await executeForSubscription(
      sub,
      direction,
      setupType,
      regime,
      intent.reference_price,
      idem
    );
    executed.push(row);
  }

  return {
    epic,
    direction,
    setup_type: setupType,
    regime,
    subscribers: subs.length,
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
  idempotencyKey: string | null
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
    // Per client/account idempotency — claim BEFORE Capital (blocks concurrent duplicates)
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

    // Security boundary: account must still belong to this client and be enabled
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

    // ONE TRADE: skip if broker already open on this epic
    const connRow = await pool.query(
      `SELECT environment, identifier, broker_name FROM broker_connections WHERE id = $1`,
      [sub.connection_id]
    );
    if (!connRow.rows.length || connRow.rows[0].broker_name !== 'capital_com') {
      return finish({
        client_id: sub.client_id,
        account_id: sub.account_id,
        lot_size: sub.lot_size,
        ok: false,
        detail: 'Not Capital.com',
        entry_price: null,
      });
    }
    const creds = await loadCreds(sub.connection_id);
    const acc = await pool.query(
      `SELECT external_account_id FROM broker_accounts WHERE id = $1`,
      [sub.account_id]
    );
    const opened = await acquireCapitalSession({
      environment: connRow.rows[0].environment as string,
      apiKey: creds.api_key || '',
      identifier: String(connRow.rows[0].identifier || '').trim(),
      password: creds.password || '',
      connectionId: sub.connection_id,
      capitalAccountId: (acc.rows[0]?.external_account_id as string | null) || null,
    });
    if (!opened.ok) {
      noteBrokerError(sub.client_id, opened.result.detail);
      emitToClient(sub.client_id, {
        type: 'error',
        message: opened.result.detail,
        robot_status: 'RUNNING',
      });
      return finish({
        client_id: sub.client_id,
        account_id: sub.account_id,
        lot_size: sub.lot_size,
        ok: false,
        detail: opened.result.detail,
        entry_price: null,
      });
    }

    const listed = await listCapitalOpenPositions(opened.session);
    if (listed.ok) {
      const existing = listed.positions.find(
        (p) => p.epic.toUpperCase() === sub.epic.toUpperCase()
      );
      if (existing) {
        noteBrokerOk(sub.client_id);
        return finish({
          client_id: sub.client_id,
          account_id: sub.account_id,
          lot_size: sub.lot_size,
          ok: false,
          detail: 'Already open on epic — skip',
          entry_price: existing.open_level,
        });
      }
    }

    // Avoid chasing end of 1m move (10s scalp guided by Capital 1m OHLC)
    const hist = await fetchCapitalMinutePrices(opened.session, sub.epic, 3);
    if (hist.ok && isLateMoveOnOneMinute(direction, hist.candles)) {
      noteBrokerOk(sub.client_id);
      return finish({
        client_id: sub.client_id,
        account_id: sub.account_id,
        lot_size: sub.lot_size,
        ok: false,
        detail: 'Skip entry — late on 1m candle (end of move)',
        entry_price: null,
      });
    }

    // SAFETY SL cushion (~0.20%), not broker minimum
    const q = await fetchCapitalMarketQuote(opened.session, sub.epic);
    const mid =
      q.mid != null && Number.isFinite(q.mid)
        ? q.mid
        : referencePrice != null && Number.isFinite(referencePrice)
          ? Number(referencePrice)
          : null;
    let stopLevel: number | undefined;
    if (mid != null) {
      stopLevel = computeSafetyCushionStopLevel(direction, mid, {
        bid: q.bid,
        ask: q.ask,
        spread: q.spread,
        minStopDistance: q.min_stop_distance,
      });
    }

    const result = await createCapitalPosition(opened.session, {
      epic: sub.epic,
      direction,
      size: sub.lot_size,
      ...(stopLevel != null ? { stopLevel } : {}),
    });

    if (!result.ok) {
      noteBrokerError(sub.client_id, result.detail);
      emitToClient(sub.client_id, {
        type: 'error',
        message: result.detail,
      });
      // NO trade_opened on failure
      return finish({
        client_id: sub.client_id,
        account_id: sub.account_id,
        lot_size: sub.lot_size,
        ok: false,
        detail: result.detail,
        entry_price: null,
      });
    }

    noteBrokerOk(sub.client_id);
    const entry =
      referencePrice != null && Number.isFinite(referencePrice) ? Number(referencePrice) : null;

    // Persist execution/position best-effort
    try {
      await pool.query(
        `INSERT INTO positions
         (broker_account_id, instrument_id, direction, entry_price, quantity, status)
         VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
        [
          sub.account_id,
          sub.instrument_id,
          direction === 'BUY' ? 'LONG' : 'SHORT',
          entry ?? 0,
          sub.lot_size,
        ]
      );
    } catch {
      /* ignore */
    }

    emitToClient(sub.client_id, {
      type: 'trade_opened',
      market: sub.epic,
      display_name: sub.display_name,
      side: direction,
      trade_type: formatTradeLabel(direction, setupType, regime),
      lot_size: sub.lot_size,
      entry_price: entry,
      account_id: sub.account_id,
      setup_type: setupType,
      regime,
    });

    // Manage-only robot: exits / health reads — no entry brain
    try {
      await attachManageOnlyRobot({
        account_id: sub.account_id,
        epic: sub.epic,
        display_name: sub.display_name,
        lot_size: sub.lot_size,
        side: direction,
        entry_price: entry,
        deal_reference: result.deal_reference || null,
        regime,
        setup_type: setupType,
      });
    } catch {
      /* manage attach best-effort */
    }

    return finish({
      client_id: sub.client_id,
      account_id: sub.account_id,
      lot_size: sub.lot_size,
      ok: true,
      detail: result.detail,
      entry_price: entry,
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
