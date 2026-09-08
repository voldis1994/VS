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
         fees, slippage, mae, mfe, r_multiple, hold_ms, exit_reason, setup_key,
         position_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
        outcome.position_id,
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
          JSON.stringify({
            decision: p.decision,
            partial_close_applied: !!p.partial_close_applied,
            multi_tp_levels: p.multi_tp_levels ?? null,
            soft_trail_armed_at: p.soft_trail_armed_at ?? null,
            soft_trail_peak: p.soft_trail_peak ?? null,
            native_trail_armed: !!p.native_trail_armed,
          }),
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
        partial_close_applied: !!payload.partial_close_applied,
        multi_tp_levels: Array.isArray(payload.multi_tp_levels)
          ? payload.multi_tp_levels
          : undefined,
        soft_trail_armed_at: payload.soft_trail_armed_at ?? null,
        soft_trail_peak:
          payload.soft_trail_peak != null ? Number(payload.soft_trail_peak) : null,
        native_trail_armed: !!payload.native_trail_armed,
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

export type JournalHistory = {
  opportunities: OpportunityRecord[];
  outcomes: Array<{
    opportunity_id: string;
    outcome: TradeOutcome;
    setup_key: string | null;
    created_at?: string;
  }>;
};

/** Load durable journal for restart hydration (file or Postgres). */
export async function loadJournalHistory(limit = 500): Promise<JournalHistory> {
  try {
    const { rows: oppRows } = await client.query(
      `SELECT id, created_at, mode, epic, executed, payload
       FROM master_opportunities ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 2000))}`
    );
    const opportunities: OpportunityRecord[] = [];
    for (const r of [...oppRows].reverse()) {
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload || {};
      if (!payload.decision || !payload.risk) continue;
      opportunities.push({
        id: String(r.id),
        ts: new Date(r.created_at).toISOString(),
        mode: r.mode,
        epic: r.epic,
        decision: payload.decision,
        risk: payload.risk,
        executed: !!r.executed,
        execution: payload.execution,
        outcome: payload.outcome,
      });
    }

    const { rows: outRows } = await client.query(
      `SELECT opportunity_id, position_id, side, entry_price, exit_price, volume, pnl, fees, slippage,
              mae, mfe, r_multiple, hold_ms, exit_reason, setup_key, created_at
       FROM master_trade_outcomes ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 2000))}`
    );
    const outcomes = [...outRows].reverse().map((r) => ({
      opportunity_id: String(r.opportunity_id),
      setup_key: r.setup_key != null ? String(r.setup_key) : null,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : undefined,
      outcome: {
        position_id: r.position_id != null ? String(r.position_id) : String(r.opportunity_id),
        side: r.side,
        entry: Number(r.entry_price),
        exit: Number(r.exit_price),
        volume: Number(r.volume),
        pnl: Number(r.pnl),
        fees: Number(r.fees) || 0,
        slippage: Number(r.slippage) || 0,
        mae: Number(r.mae) || 0,
        mfe: Number(r.mfe) || 0,
        r_multiple: Number(r.r_multiple) || 0,
        hold_ms: Number(r.hold_ms) || 0,
        exit_reason: String(r.exit_reason || ''),
      } as TradeOutcome,
    }));
    // Join outcomes onto opportunities so status().performance / traded() survive restart
    // when payload.outcome was never rewritten (ghost/external stubs persistOutcome-only).
    const byOpp = new Map(outcomes.map((o) => [o.opportunity_id, o.outcome]));
    for (const opp of opportunities) {
      if (!opp.outcome) {
        const hit = byOpp.get(opp.id);
        if (hit) opp.outcome = hit;
      }
    }
    return { opportunities, outcomes };
  } catch {
    return { opportunities: [], outcomes: [] };
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
      const payload = typeof params[15] === 'string' ? JSON.parse(params[15] as string) : params[15];
      const existing = this.opportunities.findIndex((o) => o.id === params[0]);
      const row = {
        id: params[0],
        created_at: params[1],
        mode: params[2],
        epic: params[3],
        executed: params[14],
        payload,
        params,
      };
      if (existing >= 0) this.opportunities[existing] = { ...this.opportunities[existing], ...row };
      else this.opportunities.push(row);
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO master_trade_outcomes')) {
      this.outcomes.push({
        id: params[0],
        opportunity_id: params[1],
        side: params[2],
        entry_price: params[3],
        exit_price: params[4],
        volume: params[5],
        pnl: params[6],
        fees: params[7],
        slippage: params[8],
        mae: params[9],
        mfe: params[10],
        r_multiple: params[11],
        hold_ms: params[12],
        exit_reason: params[13],
        setup_key: params[14],
        position_id: params[15] != null ? String(params[15]) : String(params[1]),
        created_at: new Date().toISOString(),
        params,
      });
      return { rows: [] };
    }
    if (s.startsWith('UPDATE master_opportunities')) {
      const id = params[0];
      const patch =
        typeof params[1] === 'string' ? JSON.parse(params[1] as string) : (params[1] as object);
      const hit = this.opportunities.find((o) => o.id === id);
      if (hit) {
        hit.executed = true;
        hit.payload = { ...(hit.payload || {}), ...patch };
      }
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
    if (s.startsWith('SELECT') && s.includes('master_opportunities')) {
      return { rows: this.opportunities };
    }
    if (s.startsWith('SELECT') && s.includes('master_trade_outcomes')) {
      return { rows: this.outcomes };
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
