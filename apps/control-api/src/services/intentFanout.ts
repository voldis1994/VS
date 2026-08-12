import { pool } from '../db/pool.js';
import { decrypt } from '../security/encryption.js';
import {
  acquireCapitalSession,
  createCapitalPosition,
  listCapitalOpenPositions,
} from './capitalCom.js';
import { emitToClient } from './clientEvents.js';
import {
  listActiveSubscriptionsForEpic,
  noteBrokerError,
  noteBrokerOk,
  type ActiveSubscription,
} from './clientSubscriptions.js';
import { formatTradeLabel } from './tradePresentation.js';
import {
  attachManageOnlyRobot,
  listRobotSessions,
  stopRobotSession,
} from './robotDesk.js';

export type PipelineIntentInput = {
  epic: string;
  direction: 'BUY' | 'SELL';
  instrument_id?: number | null;
  setup_id?: number | null;
  setup_type?: string | null;
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

  if (!epic) throw new Error('epic required');
  if (intent.decision && String(intent.decision).toUpperCase() !== 'ENTRY_READY') {
    throw new Error('Only EntryReady intents are executable');
  }

  const subs = await listActiveSubscriptionsForEpic(epic);
  const executed: FanoutResult['executed'] = [];

  for (const sub of subs) {
    const row = await executeForSubscription(sub, direction, setupType, intent.reference_price);
    executed.push(row);
  }

  return {
    epic,
    direction,
    setup_type: setupType,
    subscribers: subs.length,
    executed,
  };
}

async function executeForSubscription(
  sub: ActiveSubscription,
  direction: 'BUY' | 'SELL',
  setupType: string | null,
  referencePrice: number | null | undefined
): Promise<FanoutResult['executed'][number]> {
  try {
    // Security boundary: account must still belong to this client and be enabled
    const own = await pool.query(
      `SELECT ba.id
       FROM broker_accounts ba
       JOIN broker_connections bc ON bc.id = ba.broker_connection_id
       WHERE ba.id = $1 AND bc.client_id = $2 AND ba.enabled = true AND bc.enabled = true`,
      [sub.account_id, sub.client_id]
    );
    if (!own.rows.length) {
      return {
        client_id: sub.client_id,
        account_id: sub.account_id,
        lot_size: sub.lot_size,
        ok: false,
        detail: 'Account ownership check failed',
        entry_price: null,
      };
    }

    // ONE TRADE: skip if broker already open on this epic
    const connRow = await pool.query(
      `SELECT environment, identifier, broker_name FROM broker_connections WHERE id = $1`,
      [sub.connection_id]
    );
    if (!connRow.rows.length || connRow.rows[0].broker_name !== 'capital_com') {
      return {
        client_id: sub.client_id,
        account_id: sub.account_id,
        lot_size: sub.lot_size,
        ok: false,
        detail: 'Not Capital.com',
        entry_price: null,
      };
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
      return {
        client_id: sub.client_id,
        account_id: sub.account_id,
        lot_size: sub.lot_size,
        ok: false,
        detail: opened.result.detail,
        entry_price: null,
      };
    }

    const listed = await listCapitalOpenPositions(opened.session);
    if (listed.ok) {
      const existing = listed.positions.find(
        (p) => p.epic.toUpperCase() === sub.epic.toUpperCase()
      );
      if (existing) {
        noteBrokerOk(sub.client_id);
        return {
          client_id: sub.client_id,
          account_id: sub.account_id,
          lot_size: sub.lot_size,
          ok: false,
          detail: 'Already open on epic — skip',
          entry_price: existing.open_level,
        };
      }
    }

    const result = await createCapitalPosition(opened.session, {
      epic: sub.epic,
      direction,
      size: sub.lot_size,
    });

    if (!result.ok) {
      noteBrokerError(sub.client_id, result.detail);
      emitToClient(sub.client_id, {
        type: 'error',
        message: result.detail,
      });
      // NO trade_opened on failure
      return {
        client_id: sub.client_id,
        account_id: sub.account_id,
        lot_size: sub.lot_size,
        ok: false,
        detail: result.detail,
        entry_price: null,
      };
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
      trade_type: formatTradeLabel(direction, setupType),
      lot_size: sub.lot_size,
      entry_price: entry,
      account_id: sub.account_id,
      setup_type: setupType,
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
      });
    } catch {
      /* manage attach best-effort */
    }

    return {
      client_id: sub.client_id,
      account_id: sub.account_id,
      lot_size: sub.lot_size,
      ok: true,
      detail: result.detail,
      entry_price: entry,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    noteBrokerError(sub.client_id, detail);
    return {
      client_id: sub.client_id,
      account_id: sub.account_id,
      lot_size: sub.lot_size,
      ok: false,
      detail,
      entry_price: null,
    };
  }
}

export async function ingestAndExecuteIntent(
  intent: PipelineIntentInput
): Promise<{ intent_id: number | null; fanout: FanoutResult; deduped?: boolean }> {
  const idem =
    intent.idempotency_key && String(intent.idempotency_key).trim()
      ? String(intent.idempotency_key).trim().slice(0, 190)
      : null;

  if (idem) {
    const existing = await pool.query(
      `SELECT idempotency_key, fanout_summary FROM pipeline_intent_dedupe WHERE idempotency_key = $1`,
      [idem]
    );
    if (existing.rows.length) {
      const prev = existing.rows[0].fanout_summary as FanoutResult;
      return { intent_id: null, fanout: prev, deduped: true };
    }
  }

  let intentId: number | null = null;
  try {
    const ins = await pool.query(
      `INSERT INTO trade_intents
         (setup_id, instrument_id, direction, decision, reference_price,
          explanation, reason_codes, epic, setup_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING')
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
        `INSERT INTO pipeline_intent_dedupe (idempotency_key, fanout_summary)
         VALUES ($1, $2)
         ON CONFLICT (idempotency_key) DO NOTHING`,
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

/** Stop robotDesk entry brains for this account (Client Panel must not use them). */
export async function stopEntryRobotsForAccount(accountId: number): Promise<void> {
  for (const s of listRobotSessions()) {
    if (s.account_id === accountId && s.running) {
      await stopRobotSession(s.id);
    }
  }
}

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
