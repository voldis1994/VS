/**
 * Journal + recovery persistence.
 * Writes to Postgres when available; always keeps in-memory mirror via journal.
 */
import { randomUUID } from 'crypto';
import { pool } from '../db/pool.js';
import type { ManagedPosition } from './positionManager.js';
import type { OpportunityRecord, TradeOutcome } from './types.js';

export type PersistClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

/** Optional inject for tests — default uses pool. */
let client: PersistClient = pool;

export function setPersistClient(c: PersistClient | null) {
  client = c || pool;
}

export async function persistOpportunity(rec: OpportunityRecord): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_opportunities (
         id, created_at, mode, epic, decision_kind, side, score, block_reason,
         regime, buy_score, sell_score, risk_allowed, risk_volume, risk_reasons,
         executed, payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         executed = EXCLUDED.executed,
         payload = EXCLUDED.payload`,
      [
        rec.id,
        rec.ts,
        rec.mode,
        rec.epic,
        rec.decision.kind,
        rec.decision.side,
        rec.decision.score,
        rec.decision.block_reason,
        rec.decision.analysis.regime,
        rec.decision.buy?.score ?? null,
        rec.decision.sell?.score ?? null,
        rec.risk.allowed,
        rec.risk.volume,
        rec.risk.reasons.join(','),
        rec.executed,
        JSON.stringify({
          decision: rec.decision,
          risk: rec.risk,
          execution: rec.execution ?? null,
        }),
      ]
    );
    return true;
  } catch {
    return false;
  }
}

export async function persistOutcome(
  opportunityId: string,
  outcome: TradeOutcome,
  setupKey?: string | null
): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_trade_outcomes (
         id, opportunity_id, side, entry_price, exit_price, volume, pnl,
         fees, slippage, mae, mfe, r_multiple, hold_ms, exit_reason, setup_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        randomUUID(),
        opportunityId,
        outcome.side,
        outcome.entry,
        outcome.exit,
        outcome.volume,
        outcome.pnl,
        outcome.fees,
        outcome.slippage,
        outcome.mae,
        outcome.mfe,
        outcome.r_multiple,
        outcome.hold_ms,
        outcome.exit_reason,
        setupKey ?? null,
      ]
    );
    await client.query(
      `UPDATE master_opportunities SET executed = TRUE,
         payload = payload || $2::jsonb
       WHERE id = $1`,
      [opportunityId, JSON.stringify({ outcome })]
    );
    return true;
  } catch {
    return false;
  }
}

export async function saveOpenPositions(positions: ManagedPosition[]): Promise<boolean> {
  try {
    await client.query(`DELETE FROM master_open_positions`);
    for (const p of positions) {
      await client.query(
        `INSERT INTO master_open_positions (
           position_id, opportunity_id, intent_id, epic, side, size, entry,
           entry_at, stop_loss, take_profit, mfe, mae, regime_at_entry, payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (position_id) DO UPDATE SET
           mfe = EXCLUDED.mfe, mae = EXCLUDED.mae, payload = EXCLUDED.payload`,
        [
          p.position_id,
          p.opportunity_id,
          p.intent_id,
          p.epic,
          p.side,
          p.size,
          p.entry,
          p.entry_at,
          p.stop_loss,
          p.take_profit,
          p.mfe,
          p.mae,
          p.regime_at_entry,
          JSON.stringify({ decision: p.decision }),
        ]
      );
    }
    return true;
  } catch {
    return false;
  }
}

export async function loadOpenPositions(): Promise<ManagedPosition[]> {
  try {
    const { rows } = await client.query(
      `SELECT position_id, opportunity_id, intent_id, epic, side, size, entry,
              entry_at, stop_loss, take_profit, mfe, mae, regime_at_entry, payload
       FROM master_open_positions`
    );
    return rows.map((r) => {
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload || {};
      return {
        position_id: r.position_id,
        opportunity_id: r.opportunity_id,
        intent_id: r.intent_id,
        epic: r.epic,
        side: r.side,
        size: Number(r.size),
        entry: Number(r.entry),
        entry_at: new Date(r.entry_at).toISOString(),
        stop_loss: r.stop_loss != null ? Number(r.stop_loss) : null,
        take_profit: r.take_profit != null ? Number(r.take_profit) : null,
        mfe: Number(r.mfe) || 0,
        mae: Number(r.mae) || 0,
        decision: payload.decision,
        regime_at_entry: r.regime_at_entry || 'UNKNOWN',
      } as ManagedPosition;
    });
  } catch {
    return [];
  }
}

export async function saveSeenIntents(intentIds: string[]): Promise<boolean> {
  try {
    for (const id of intentIds.slice(-500)) {
      await client.query(
        `INSERT INTO master_seen_intents (intent_id) VALUES ($1)
         ON CONFLICT (intent_id) DO NOTHING`,
        [id]
      );
    }
    return true;
  } catch {
    return false;
  }
}

export async function loadSeenIntents(): Promise<string[]> {
  try {
    const { rows } = await client.query(
      `SELECT intent_id FROM master_seen_intents ORDER BY created_at DESC LIMIT 500`
    );
    return rows.map((r) => String(r.intent_id));
  } catch {
    return [];
  }
}

/** In-memory persist for unit tests (no Postgres). */
export class MemoryPersist implements PersistClient {
  opportunities: any[] = [];
  outcomes: any[] = [];
  positions: any[] = [];
  intents: Set<string> = new Set();

  async query(sql: string, params: unknown[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT INTO master_opportunities')) {
      this.opportunities.push({ id: params[0], params });
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO master_trade_outcomes')) {
      this.outcomes.push({ id: params[0], opportunity_id: params[1], params });
      return { rows: [] };
    }
    if (s.startsWith('UPDATE master_opportunities')) {
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM master_open_positions')) {
      this.positions = [];
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO master_open_positions')) {
      this.positions.push({
        position_id: params[0],
        opportunity_id: params[1],
        intent_id: params[2],
        epic: params[3],
        side: params[4],
        size: params[5],
        entry: params[6],
        entry_at: params[7],
        stop_loss: params[8],
        take_profit: params[9],
        mfe: params[10],
        mae: params[11],
        regime_at_entry: params[12],
        payload: typeof params[13] === 'string' ? JSON.parse(params[13] as string) : params[13],
      });
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_open_positions')) {
      return { rows: this.positions };
    }
    if (s.startsWith('INSERT INTO master_seen_intents')) {
      this.intents.add(String(params[0]));
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_seen_intents')) {
      return { rows: [...this.intents].map((intent_id) => ({ intent_id })) };
    }
    return { rows: [] };
  }
}
