/**
 * Journal + recovery persistence.
 * Writes to Postgres when available; always keeps in-memory mirror via journal.
 */
import { randomUUID } from 'crypto';
import { pool } from '../db/pool.js';
import { mergeOutcomeSlices } from './journal.js';
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

/** Current PersistClient (pool / DualPersist / FilePersist / MemoryPersist). */
export function getPersistClient(): PersistClient {
  return client;
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
         position_id, pnl_proven
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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
        outcome.pnl_proven === false
          ? false
          : outcome.pnl_proven === true
            ? true
            : null,
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

/** DualPersist / MemoryPersist / PG — market_cache singleton for wipe heal. */
export async function persistMarketCacheState(state: {
  epic: string;
  bars: unknown[];
  quote: unknown;
  hour_bars?: unknown[];
  hour_bars_detail?: string | null;
  closed_10s?: unknown;
  structure_seed_source?: string | null;
  saved_at_ms: number;
}): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_market_cache (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      ['singleton', JSON.stringify(state), state.saved_at_ms]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadMarketCacheFromPersist(): Promise<any | null> {
  try {
    const { rows } = await client.query(
      `SELECT payload, saved_at_ms FROM master_market_cache WHERE id = $1 LIMIT 1`,
      ['singleton']
    );
    const row = rows?.[0];
    if (!row) return null;
    const payload =
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== 'object') return null;
    return {
      ...payload,
      saved_at_ms: Number(row.saved_at_ms) || Number(payload.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}

/** DualPersist / MemoryPersist / PG — epic_cycle_stash singleton for wipe heal. */
export async function persistEpicCycleStashState(state: {
  at: string;
  setups_by_epic: Record<string, unknown>;
  cycles_by_epic: Record<string, unknown>;
  saved_at_ms: number;
}): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_epic_cycle_stash (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      ['singleton', JSON.stringify(state), state.saved_at_ms]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadEpicCycleStashFromPersist(): Promise<any | null> {
  try {
    const { rows } = await client.query(
      `SELECT payload, saved_at_ms FROM master_epic_cycle_stash WHERE id = $1 LIMIT 1`,
      ['singleton']
    );
    const row = rows?.[0];
    if (!row) return null;
    const payload =
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== 'object') return null;
    return {
      ...payload,
      saved_at_ms: Number(row.saved_at_ms) || Number(payload.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}

/** DualPersist / MemoryPersist / PG — runtime_gates singleton for wipe heal. */
export async function persistRuntimeGatesState(
  state: Record<string, unknown> & { saved_at_ms: number }
): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_runtime_gates (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      ['singleton', JSON.stringify(state), state.saved_at_ms]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadRuntimeGatesFromPersist(): Promise<any | null> {
  try {
    const { rows } = await client.query(
      `SELECT payload, saved_at_ms FROM master_runtime_gates WHERE id = $1 LIMIT 1`,
      ['singleton']
    );
    const row = rows?.[0];
    if (!row) return null;
    const payload =
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== 'object') return null;
    return {
      ...payload,
      saved_at_ms: Number(row.saved_at_ms) || Number(payload.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}

/** DualPersist / MemoryPersist / PG — manage_config singleton for wipe heal. */
export async function persistManageConfigState(
  state: Record<string, unknown> & { saved_at_ms: number }
): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_manage_config (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      ['singleton', JSON.stringify(state), state.saved_at_ms]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadManageConfigFromPersist(): Promise<any | null> {
  try {
    const { rows } = await client.query(
      `SELECT payload, saved_at_ms FROM master_manage_config WHERE id = $1 LIMIT 1`,
      ['singleton']
    );
    const row = rows?.[0];
    if (!row) return null;
    const payload =
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== 'object') return null;
    return {
      ...payload,
      saved_at_ms: Number(row.saved_at_ms) || Number(payload.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}

/** DualPersist / MemoryPersist / PG — owns_pipeline singleton for wipe heal. */
export async function persistOwnsPipelineState(state: {
  owns_pipeline: boolean;
  saved_at_ms: number;
}): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_owns_pipeline (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      [
        'singleton',
        JSON.stringify({ owns_pipeline: state.owns_pipeline === true }),
        state.saved_at_ms,
      ]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadOwnsPipelineFromPersist(): Promise<{
  owns_pipeline: boolean;
  saved_at_ms: number;
} | null> {
  try {
    const { rows } = await client.query(
      `SELECT payload, saved_at_ms FROM master_owns_pipeline WHERE id = $1 LIMIT 1`,
      ['singleton']
    );
    const row = rows?.[0];
    if (!row) return null;
    const payload =
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.owns_pipeline !== 'boolean') return null;
    return {
      owns_pipeline: payload.owns_pipeline === true,
      saved_at_ms: Number(row.saved_at_ms) || Number(payload.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}

/** DualPersist / MemoryPersist / PG — monitoring_snapshot singleton for wipe heal. */
export async function persistMonitoringSnapshotState(
  state: Record<string, unknown> & { saved_at_ms: number }
): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_monitoring_snapshot (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      ['singleton', JSON.stringify(state), state.saved_at_ms]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadMonitoringSnapshotFromPersist(): Promise<any | null> {
  try {
    const { rows } = await client.query(
      `SELECT payload, saved_at_ms FROM master_monitoring_snapshot WHERE id = $1 LIMIT 1`,
      ['singleton']
    );
    const row = rows?.[0];
    if (!row) return null;
    const payload =
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== 'object') return null;
    return {
      ...payload,
      saved_at_ms: Number(row.saved_at_ms) || Number(payload.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}

/** DualPersist / MemoryPersist / PG — spread_history singleton for wipe heal. */
export async function persistSpreadHistoryState(state: {
  lookback: number;
  history: number[];
  ts?: string;
  saved_at_ms: number;
}): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_spread_history (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      [
        'singleton',
        JSON.stringify({
          lookback: state.lookback,
          history: state.history,
          ts: state.ts || new Date().toISOString(),
        }),
        state.saved_at_ms,
      ]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadSpreadHistoryFromPersist(): Promise<any | null> {
  try {
    const { rows } = await client.query(
      `SELECT payload, saved_at_ms FROM master_spread_history WHERE id = $1 LIMIT 1`,
      ['singleton']
    );
    const row = rows?.[0];
    if (!row) return null;
    const payload =
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== 'object') return null;
    return {
      ...payload,
      saved_at_ms: Number(row.saved_at_ms) || Number(payload.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}

/** DualPersist / MemoryPersist / PG — trade_ack_journal singleton for wipe heal. */
export async function persistTradeAckJournalState(state: {
  records: Record<string, unknown>;
  saved_at_ms: number;
}): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_trade_ack_journal (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      [
        'singleton',
        JSON.stringify({
          records:
            state.records && typeof state.records === 'object'
              ? state.records
              : {},
        }),
        state.saved_at_ms,
      ]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadTradeAckJournalFromPersist(): Promise<any | null> {
  try {
    const { rows } = await client.query(
      `SELECT payload, saved_at_ms FROM master_trade_ack_journal WHERE id = $1 LIMIT 1`,
      ['singleton']
    );
    const row = rows?.[0];
    if (!row) return null;
    const payload =
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== 'object') return null;
    return {
      ...payload,
      saved_at_ms: Number(row.saved_at_ms) || Number(payload.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}

/** DualPersist / MemoryPersist / PG — error_journal singleton for wipe heal. */
export async function persistErrorJournalState(state: {
  entries: unknown[];
  saved_at_ms: number;
}): Promise<boolean> {
  try {
    const entries = Array.isArray(state.entries) ? state.entries : [];
    await client.query(
      `INSERT INTO master_error_journal (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      [
        'singleton',
        JSON.stringify({ entries }),
        state.saved_at_ms,
      ]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadErrorJournalFromPersist(): Promise<any | null> {
  try {
    const { rows } = await client.query(
      `SELECT payload, saved_at_ms FROM master_error_journal WHERE id = $1 LIMIT 1`,
      ['singleton']
    );
    const row = rows?.[0];
    if (!row) return null;
    const payload =
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== 'object') return null;
    return {
      ...payload,
      saved_at_ms: Number(row.saved_at_ms) || Number(payload.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}

/** DualPersist / MemoryPersist / PG — news_window singleton for wipe heal. */
export async function persistNewsWindowState(state: {
  impact: string;
  until_ms?: number | null;
  active?: boolean;
  detail?: string | null;
  saved_at_ms: number;
}): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_news_window (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      [
        'singleton',
        JSON.stringify({
          impact: state.impact,
          until_ms:
            state.until_ms != null && Number.isFinite(Number(state.until_ms))
              ? Number(state.until_ms)
              : null,
          active: state.active === true,
          detail: state.detail ?? null,
        }),
        state.saved_at_ms,
      ]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadNewsWindowFromPersist(): Promise<any | null> {
  try {
    const { rows } = await client.query(
      `SELECT payload, saved_at_ms FROM master_news_window WHERE id = $1 LIMIT 1`,
      ['singleton']
    );
    const row = rows?.[0];
    if (!row) return null;
    const payload =
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== 'object') return null;
    return {
      ...payload,
      saved_at_ms: Number(row.saved_at_ms) || Number(payload.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}

/** DualPersist / MemoryPersist / PG — client_fanout singleton for wipe heal. */
export async function persistClientFanoutState(state: {
  attempted: boolean;
  subscribers: number;
  ok_count: number;
  fail_count: number;
  detail: string;
  journaled_count?: number;
  ts?: string;
  saved_at_ms: number;
}): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_client_fanout (id, payload, saved_at_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET
         payload = EXCLUDED.payload,
         saved_at_ms = EXCLUDED.saved_at_ms`,
      [
        'singleton',
        JSON.stringify({
          attempted: state.attempted === true,
          subscribers: Math.max(0, Math.floor(Number(state.subscribers) || 0)),
          ok_count: Math.max(0, Math.floor(Number(state.ok_count) || 0)),
          fail_count: Math.max(0, Math.floor(Number(state.fail_count) || 0)),
          detail: String(state.detail || '').slice(0, 400),
          journaled_count:
            state.journaled_count != null
              ? Math.max(0, Math.floor(Number(state.journaled_count) || 0))
              : 0,
          ts: state.ts || new Date().toISOString(),
        }),
        state.saved_at_ms,
      ]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadClientFanoutFromPersist(): Promise<any | null> {
  try {
    const { rows } = await client.query(
      `SELECT payload, saved_at_ms FROM master_client_fanout WHERE id = $1 LIMIT 1`,
      ['singleton']
    );
    const row = rows?.[0];
    if (!row) return null;
    const payload =
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!payload || typeof payload !== 'object') return null;
    return {
      ...payload,
      saved_at_ms: Number(row.saved_at_ms) || Number(payload.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}

/** Reader decision audit — DualPersist / MemoryPersist / FilePersist SQL path. */
export async function persistDecisionEvent(entry: {
  event_id: string;
  ts: string;
  kind: string;
  epic: string;
  mode: string;
  opportunity_id: string | null;
  buy_score: number;
  sell_score: number;
  block_reason: string | null;
  executed: boolean;
  execution_detail: string | null;
  cycle_ms: number | null;
  desk_entry_source?: 'setup' | 'move' | null;
  desk_entry_side?: 'BUY' | 'SELL' | null;
  hour_bias?: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN' | null;
  closed_10s_present?: boolean | null;
}): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_decision_events (
         event_id, ts, kind, epic, mode, opportunity_id,
         buy_score, sell_score, block_reason, executed, execution_detail, cycle_ms,
         desk_entry_source, desk_entry_side, hour_bias, closed_10s_present
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        entry.event_id,
        entry.ts,
        entry.kind,
        entry.epic,
        entry.mode,
        entry.opportunity_id,
        entry.buy_score,
        entry.sell_score,
        entry.block_reason,
        entry.executed,
        entry.execution_detail,
        entry.cycle_ms,
        entry.desk_entry_source ?? null,
        entry.desk_entry_side ?? null,
        entry.hour_bias ?? null,
        typeof entry.closed_10s_present === 'boolean'
          ? entry.closed_10s_present
          : null,
      ]
    );
    return true;
  } catch {
    return false;
  }
}

/** Reader trade audit — DualPersist / MemoryPersist / FilePersist SQL path. */
export async function persistTradeEvent(entry: {
  event_id: string;
  ts: string;
  event: string;
  broker: string;
  epic: string;
  side: string | null;
  volume: number | null;
  price: number | null;
  position_id: string | null;
  intent_id: string | null;
  opportunity_id: string | null;
  ok: boolean;
  detail: string | null;
  pnl: number | null;
  fees: number | null;
  desk_entry_source?: 'setup' | 'move' | 'none' | null;
}): Promise<boolean> {
  try {
    await client.query(
      `INSERT INTO master_trade_events (
         event_id, ts, event, broker, epic, side, volume, price,
         position_id, intent_id, opportunity_id, ok, detail, pnl, fees,
         desk_entry_source
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        entry.event_id,
        entry.ts,
        entry.event,
        entry.broker,
        entry.epic,
        entry.side,
        entry.volume,
        entry.price,
        entry.position_id,
        entry.intent_id,
        entry.opportunity_id,
        entry.ok,
        entry.detail,
        entry.pnl,
        entry.fees,
        entry.desk_entry_source === 'setup' ||
        entry.desk_entry_source === 'move' ||
        entry.desk_entry_source === 'none'
          ? entry.desk_entry_source
          : null,
      ]
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadDecisionEventsFromPersist(
  limit = 50
): Promise<
  Array<{
    event_id: string;
    ts: string;
    kind: string;
    epic: string;
    mode: string;
    opportunity_id: string | null;
    buy_score: number;
    sell_score: number;
    block_reason: string | null;
    executed: boolean;
    execution_detail: string | null;
    cycle_ms: number | null;
    desk_entry_source: 'setup' | 'move' | null;
    desk_entry_side: 'BUY' | 'SELL' | null;
    hour_bias: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN' | null;
    closed_10s_present: boolean | null;
  }>
> {
  try {
    const { rows } = await client.query(
      `SELECT event_id, ts, kind, epic, mode, opportunity_id,
              buy_score, sell_score, block_reason, executed, execution_detail, cycle_ms,
              desk_entry_source, desk_entry_side, hour_bias, closed_10s_present
       FROM master_decision_events
       ORDER BY ts DESC
       LIMIT $1`,
      [Math.max(1, Math.min(500, limit))]
    );
    return (rows || []).map((r: any) => ({
      event_id: String(r.event_id),
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      kind: String(r.kind || 'WAIT'),
      epic: String(r.epic || ''),
      mode: String(r.mode || 'PAPER'),
      opportunity_id: r.opportunity_id != null ? String(r.opportunity_id) : null,
      buy_score: Number(r.buy_score) || 0,
      sell_score: Number(r.sell_score) || 0,
      block_reason: r.block_reason != null ? String(r.block_reason) : null,
      executed: !!r.executed,
      execution_detail:
        r.execution_detail != null ? String(r.execution_detail) : null,
      cycle_ms:
        r.cycle_ms != null && Number.isFinite(Number(r.cycle_ms))
          ? Math.round(Number(r.cycle_ms))
          : null,
      desk_entry_source:
        r.desk_entry_source === 'setup' || r.desk_entry_source === 'move'
          ? r.desk_entry_source
          : null,
      desk_entry_side:
        r.desk_entry_side === 'BUY' || r.desk_entry_side === 'SELL'
          ? r.desk_entry_side
          : null,
      hour_bias:
        r.hour_bias === 'UP' ||
        r.hour_bias === 'DOWN' ||
        r.hour_bias === 'FLAT' ||
        r.hour_bias === 'UNKNOWN'
          ? r.hour_bias
          : null,
      closed_10s_present:
        typeof r.closed_10s_present === 'boolean'
          ? r.closed_10s_present
          : r.closed_10s_present == null
            ? null
            : !!r.closed_10s_present,
    }));
  } catch {
    return [];
  }
}

export async function loadTradeEventsFromPersist(
  limit = 50
): Promise<
  Array<{
    event_id: string;
    ts: string;
    event: string;
    broker: string;
    epic: string;
    side: string | null;
    volume: number | null;
    price: number | null;
    position_id: string | null;
    intent_id: string | null;
    opportunity_id: string | null;
    ok: boolean;
    detail: string | null;
    pnl: number | null;
    fees: number | null;
    desk_entry_source: 'setup' | 'move' | 'none' | null;
  }>
> {
  try {
    const { rows } = await client.query(
      `SELECT event_id, ts, event, broker, epic, side, volume, price,
              position_id, intent_id, opportunity_id, ok, detail, pnl, fees,
              desk_entry_source
       FROM master_trade_events
       ORDER BY ts DESC
       LIMIT $1`,
      [Math.max(1, Math.min(500, limit))]
    );
    return (rows || []).map((r: any) => ({
      event_id: String(r.event_id),
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      event: String(r.event || 'OPEN'),
      broker: String(r.broker || 'UNKNOWN'),
      epic: String(r.epic || ''),
      side: r.side != null ? String(r.side) : null,
      volume:
        r.volume != null && Number.isFinite(Number(r.volume))
          ? Number(r.volume)
          : null,
      price:
        r.price != null && Number.isFinite(Number(r.price))
          ? Number(r.price)
          : null,
      position_id: r.position_id != null ? String(r.position_id) : null,
      intent_id: r.intent_id != null ? String(r.intent_id) : null,
      opportunity_id: r.opportunity_id != null ? String(r.opportunity_id) : null,
      ok: !!r.ok,
      detail: r.detail != null ? String(r.detail) : null,
      pnl:
        r.pnl != null && Number.isFinite(Number(r.pnl)) ? Number(r.pnl) : null,
      fees:
        r.fees != null && Number.isFinite(Number(r.fees))
          ? Number(r.fees)
          : null,
      desk_entry_source:
        r.desk_entry_source === 'setup' ||
        r.desk_entry_source === 'move' ||
        r.desk_entry_source === 'none'
          ? r.desk_entry_source
          : null,
    }));
  } catch {
    return [];
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
            scalp_chase_at_ms: p.scalp_chase_at_ms ?? null,
            ema3_side: p.ema3_side ?? null,
            modify_reject_level: p.modify_reject_level ?? null,
            modify_backoff_until_ms: p.modify_backoff_until_ms ?? null,
            intended_stop_loss: p.intended_stop_loss ?? null,
            intended_take_profit: p.intended_take_profit ?? null,
            naked_recovery_level: p.naked_recovery_level ?? null,
            playbook_at_entry: p.playbook_at_entry ?? null,
            entry_setup: p.entry_setup ?? null,
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
      const emaSide = payload.ema3_side;
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
        scalp_chase_at_ms:
          payload.scalp_chase_at_ms != null && Number.isFinite(Number(payload.scalp_chase_at_ms))
            ? Number(payload.scalp_chase_at_ms)
            : null,
        ema3_side: emaSide === 'above' || emaSide === 'below' ? emaSide : null,
        modify_reject_level:
          payload.modify_reject_level != null &&
          Number.isFinite(Number(payload.modify_reject_level))
            ? Number(payload.modify_reject_level)
            : null,
        modify_backoff_until_ms:
          payload.modify_backoff_until_ms != null &&
          Number.isFinite(Number(payload.modify_backoff_until_ms))
            ? Number(payload.modify_backoff_until_ms)
            : null,
        intended_stop_loss:
          payload.intended_stop_loss != null &&
          Number.isFinite(Number(payload.intended_stop_loss)) &&
          Number(payload.intended_stop_loss) > 0
            ? Number(payload.intended_stop_loss)
            : null,
        intended_take_profit:
          payload.intended_take_profit != null &&
          Number.isFinite(Number(payload.intended_take_profit)) &&
          Number(payload.intended_take_profit) > 0
            ? Number(payload.intended_take_profit)
            : null,
        naked_recovery_level:
          payload.naked_recovery_level != null &&
          Number.isFinite(Number(payload.naked_recovery_level))
            ? Math.max(0, Math.floor(Number(payload.naked_recovery_level)))
            : null,
        playbook_at_entry:
          payload.playbook_at_entry === 'LONG' ||
          payload.playbook_at_entry === 'SCALP' ||
          payload.playbook_at_entry === 'FADE'
            ? payload.playbook_at_entry
            : undefined,
        entry_setup:
          typeof payload.entry_setup === 'string' && payload.entry_setup.trim()
            ? String(payload.entry_setup)
            : undefined,
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
              mae, mfe, r_multiple, hold_ms, exit_reason, setup_key, created_at, pnl_proven
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
        ...(r.pnl_proven === false
          ? { pnl_proven: false as const }
          : r.pnl_proven === true
            ? { pnl_proven: true as const }
            : {}),
      } as TradeOutcome,
    }));
    // Pre-migration PG: column null but opportunity payload still has pnl_proven
    for (const o of outcomes) {
      if (o.outcome.pnl_proven === false || o.outcome.pnl_proven === true) continue;
      const opp = opportunities.find((x) => x.id === o.opportunity_id);
      const flag = opp?.outcome?.pnl_proven;
      if (flag === false || flag === true) o.outcome.pnl_proven = flag;
    }
    // Join ALL outcome slices onto opportunities so multi-TP / external partials
    // survive restart. Aggregate when multiple slices share an opportunity_id.
    const slicesByOpp = new Map<string, TradeOutcome[]>();
    for (const o of outcomes) {
      const list = slicesByOpp.get(o.opportunity_id) || [];
      list.push(o.outcome);
      slicesByOpp.set(o.opportunity_id, list);
    }
    for (const opp of opportunities) {
      const payloadFlag =
        opp.outcome?.pnl_proven === false
          ? false
          : opp.outcome?.pnl_proven === true
            ? true
            : null;
      const slices = slicesByOpp.get(opp.id);
      if (!slices?.length) continue;
      const fromDb = slices.reduce((acc, s) =>
        acc ? mergeOutcomeSlices(acc, s) : s
      );
      if (!opp.outcome) {
        opp.outcome = fromDb;
      } else if (slices.length > 1) {
        // Prefer full slice sum over single payload rewrite
        opp.outcome = fromDb;
      } else if (
        opp.outcome.pnl_proven == null &&
        fromDb.pnl_proven != null
      ) {
        opp.outcome = { ...opp.outcome, pnl_proven: fromDb.pnl_proven };
      }
      if (
        opp.outcome &&
        opp.outcome.pnl_proven == null &&
        (payloadFlag === false || payloadFlag === true)
      ) {
        opp.outcome.pnl_proven = payloadFlag;
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
  /** Reader audit tails — DualPersist primary when PG tables exist */
  decisionEvents: any[] = [];
  tradeEvents: any[] = [];
  /** Singleton market_cache payload — DualPersist primary wipe heal */
  marketCachePayload: any | null = null;
  /** Singleton epic_cycle_stash payload — DualPersist primary wipe heal */
  epicCycleStashPayload: any | null = null;
  /** Singleton runtime_gates payload — DualPersist primary wipe heal */
  runtimeGatesPayload: any | null = null;
  /** Singleton manage_config payload — DualPersist primary wipe heal */
  manageConfigPayload: any | null = null;
  /** Singleton owns_pipeline payload — DualPersist primary wipe heal */
  ownsPipelinePayload: { owns_pipeline: boolean; saved_at_ms?: number } | null =
    null;
  /** Singleton monitoring_snapshot payload — DualPersist primary wipe heal */
  monitoringSnapshotPayload: any | null = null;
  /** Singleton spread_history payload — DualPersist primary wipe heal */
  spreadHistoryPayload: any | null = null;
  /** Singleton trade_ack_journal payload — DualPersist primary wipe heal */
  tradeAckJournalPayload: any | null = null;
  /** Singleton error_journal payload — DualPersist primary wipe heal */
  errorJournalPayload: any | null = null;
  /** Singleton news_window payload — DualPersist primary wipe heal */
  newsWindowPayload: any | null = null;
  /** Singleton client_fanout payload — DualPersist primary wipe heal */
  clientFanoutPayload: any | null = null;

  async query(sql: string, params: unknown[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT INTO master_market_cache')) {
      const raw = params[1];
      this.marketCachePayload =
        typeof raw === 'string' ? JSON.parse(raw as string) : raw;
      if (
        this.marketCachePayload &&
        typeof this.marketCachePayload === 'object' &&
        params[2] != null
      ) {
        this.marketCachePayload.saved_at_ms = Number(params[2]) || Date.now();
      }
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_market_cache')) {
      if (!this.marketCachePayload) return { rows: [] };
      return {
        rows: [
          {
            id: 'singleton',
            payload: this.marketCachePayload,
            saved_at_ms: Number(this.marketCachePayload.saved_at_ms) || 0,
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO master_epic_cycle_stash')) {
      const raw = params[1];
      this.epicCycleStashPayload =
        typeof raw === 'string' ? JSON.parse(raw as string) : raw;
      if (
        this.epicCycleStashPayload &&
        typeof this.epicCycleStashPayload === 'object' &&
        params[2] != null
      ) {
        this.epicCycleStashPayload.saved_at_ms =
          Number(params[2]) || Date.now();
      }
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_epic_cycle_stash')) {
      if (!this.epicCycleStashPayload) return { rows: [] };
      return {
        rows: [
          {
            id: 'singleton',
            payload: this.epicCycleStashPayload,
            saved_at_ms: Number(this.epicCycleStashPayload.saved_at_ms) || 0,
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO master_runtime_gates')) {
      const raw = params[1];
      this.runtimeGatesPayload =
        typeof raw === 'string' ? JSON.parse(raw as string) : raw;
      if (
        this.runtimeGatesPayload &&
        typeof this.runtimeGatesPayload === 'object' &&
        params[2] != null
      ) {
        this.runtimeGatesPayload.saved_at_ms = Number(params[2]) || Date.now();
      }
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_runtime_gates')) {
      if (!this.runtimeGatesPayload) return { rows: [] };
      return {
        rows: [
          {
            id: 'singleton',
            payload: this.runtimeGatesPayload,
            saved_at_ms: Number(this.runtimeGatesPayload.saved_at_ms) || 0,
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO master_manage_config')) {
      const raw = params[1];
      this.manageConfigPayload =
        typeof raw === 'string' ? JSON.parse(raw as string) : raw;
      if (
        this.manageConfigPayload &&
        typeof this.manageConfigPayload === 'object' &&
        params[2] != null
      ) {
        this.manageConfigPayload.saved_at_ms = Number(params[2]) || Date.now();
      }
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_manage_config')) {
      if (!this.manageConfigPayload) return { rows: [] };
      return {
        rows: [
          {
            id: 'singleton',
            payload: this.manageConfigPayload,
            saved_at_ms: Number(this.manageConfigPayload.saved_at_ms) || 0,
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO master_owns_pipeline')) {
      const raw = params[1];
      const parsed =
        typeof raw === 'string' ? JSON.parse(raw as string) : (raw as any);
      this.ownsPipelinePayload = {
        owns_pipeline: parsed?.owns_pipeline === true,
        saved_at_ms: Number(params[2]) || Date.now(),
      };
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_owns_pipeline')) {
      if (!this.ownsPipelinePayload) return { rows: [] };
      return {
        rows: [
          {
            id: 'singleton',
            payload: {
              owns_pipeline: this.ownsPipelinePayload.owns_pipeline === true,
            },
            saved_at_ms: Number(this.ownsPipelinePayload.saved_at_ms) || 0,
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO master_monitoring_snapshot')) {
      const raw = params[1];
      this.monitoringSnapshotPayload =
        typeof raw === 'string' ? JSON.parse(raw as string) : raw;
      if (
        this.monitoringSnapshotPayload &&
        typeof this.monitoringSnapshotPayload === 'object' &&
        params[2] != null
      ) {
        this.monitoringSnapshotPayload.saved_at_ms =
          Number(params[2]) || Date.now();
      }
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_monitoring_snapshot')) {
      if (!this.monitoringSnapshotPayload) return { rows: [] };
      return {
        rows: [
          {
            id: 'singleton',
            payload: this.monitoringSnapshotPayload,
            saved_at_ms:
              Number(this.monitoringSnapshotPayload.saved_at_ms) || 0,
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO master_spread_history')) {
      const raw = params[1];
      this.spreadHistoryPayload =
        typeof raw === 'string' ? JSON.parse(raw as string) : raw;
      if (
        this.spreadHistoryPayload &&
        typeof this.spreadHistoryPayload === 'object' &&
        params[2] != null
      ) {
        this.spreadHistoryPayload.saved_at_ms =
          Number(params[2]) || Date.now();
      }
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_spread_history')) {
      if (!this.spreadHistoryPayload) return { rows: [] };
      return {
        rows: [
          {
            id: 'singleton',
            payload: this.spreadHistoryPayload,
            saved_at_ms: Number(this.spreadHistoryPayload.saved_at_ms) || 0,
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO master_trade_ack_journal')) {
      const raw = params[1];
      this.tradeAckJournalPayload =
        typeof raw === 'string' ? JSON.parse(raw as string) : raw;
      if (
        this.tradeAckJournalPayload &&
        typeof this.tradeAckJournalPayload === 'object' &&
        params[2] != null
      ) {
        this.tradeAckJournalPayload.saved_at_ms =
          Number(params[2]) || Date.now();
      }
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_trade_ack_journal')) {
      if (!this.tradeAckJournalPayload) return { rows: [] };
      return {
        rows: [
          {
            id: 'singleton',
            payload: this.tradeAckJournalPayload,
            saved_at_ms:
              Number(this.tradeAckJournalPayload.saved_at_ms) || 0,
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO master_error_journal')) {
      const raw = params[1];
      this.errorJournalPayload =
        typeof raw === 'string' ? JSON.parse(raw as string) : raw;
      if (
        this.errorJournalPayload &&
        typeof this.errorJournalPayload === 'object' &&
        params[2] != null
      ) {
        this.errorJournalPayload.saved_at_ms =
          Number(params[2]) || Date.now();
      }
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_error_journal')) {
      if (!this.errorJournalPayload) return { rows: [] };
      return {
        rows: [
          {
            id: 'singleton',
            payload: this.errorJournalPayload,
            saved_at_ms: Number(this.errorJournalPayload.saved_at_ms) || 0,
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO master_news_window')) {
      const raw = params[1];
      this.newsWindowPayload =
        typeof raw === 'string' ? JSON.parse(raw as string) : raw;
      if (
        this.newsWindowPayload &&
        typeof this.newsWindowPayload === 'object' &&
        params[2] != null
      ) {
        this.newsWindowPayload.saved_at_ms = Number(params[2]) || Date.now();
      }
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_news_window')) {
      if (!this.newsWindowPayload) return { rows: [] };
      return {
        rows: [
          {
            id: 'singleton',
            payload: this.newsWindowPayload,
            saved_at_ms: Number(this.newsWindowPayload.saved_at_ms) || 0,
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO master_client_fanout')) {
      const raw = params[1];
      this.clientFanoutPayload =
        typeof raw === 'string' ? JSON.parse(raw as string) : raw;
      if (
        this.clientFanoutPayload &&
        typeof this.clientFanoutPayload === 'object' &&
        params[2] != null
      ) {
        this.clientFanoutPayload.saved_at_ms =
          Number(params[2]) || Date.now();
      }
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_client_fanout')) {
      if (!this.clientFanoutPayload) return { rows: [] };
      return {
        rows: [
          {
            id: 'singleton',
            payload: this.clientFanoutPayload,
            saved_at_ms: Number(this.clientFanoutPayload.saved_at_ms) || 0,
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO master_decision_events')) {
      const event_id = String(params[0]);
      if (!this.decisionEvents.some((e) => e.event_id === event_id)) {
        this.decisionEvents.push({
          event_id,
          ts: params[1],
          kind: params[2],
          epic: params[3],
          mode: params[4],
          opportunity_id: params[5],
          buy_score: params[6],
          sell_score: params[7],
          block_reason: params[8],
          executed: params[9],
          execution_detail: params[10],
          cycle_ms: params[11],
          desk_entry_source: params[12] ?? null,
          desk_entry_side: params[13] ?? null,
          hour_bias: params[14] ?? null,
          closed_10s_present:
            typeof params[15] === 'boolean' ? params[15] : params[15] ?? null,
        });
        if (this.decisionEvents.length > 500) {
          this.decisionEvents = this.decisionEvents.slice(-500);
        }
      }
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO master_trade_events')) {
      const event_id = String(params[0]);
      if (!this.tradeEvents.some((e) => e.event_id === event_id)) {
        this.tradeEvents.push({
          event_id,
          ts: params[1],
          event: params[2],
          broker: params[3],
          epic: params[4],
          side: params[5],
          volume: params[6],
          price: params[7],
          position_id: params[8],
          intent_id: params[9],
          opportunity_id: params[10],
          ok: params[11],
          detail: params[12],
          pnl: params[13],
          fees: params[14],
          desk_entry_source: params[15] ?? null,
        });
        if (this.tradeEvents.length > 500) {
          this.tradeEvents = this.tradeEvents.slice(-500);
        }
      }
      return { rows: [] };
    }
    if (s.startsWith('SELECT') && s.includes('master_decision_events')) {
      const lim = Number(params[0]) || 50;
      const rows = [...this.decisionEvents]
        .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
        .slice(0, lim);
      return { rows };
    }
    if (s.startsWith('SELECT') && s.includes('master_trade_events')) {
      const lim = Number(params[0]) || 50;
      const rows = [...this.tradeEvents]
        .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
        .slice(0, lim);
      return { rows };
    }
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
        pnl_proven:
          params[16] === false ? false : params[16] === true ? true : undefined,
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
      // Round-trip pnl_proven onto the latest outcome row (Postgres has no column)
      const outcome = (patch as { outcome?: TradeOutcome }).outcome;
      if (outcome && id != null) {
        const outs = this.outcomes.filter((o) => String(o.opportunity_id) === String(id));
        const last = outs[outs.length - 1];
        if (last) {
          if (outcome.pnl_proven === false) last.pnl_proven = false;
          else if (outcome.pnl_proven === true) last.pnl_proven = true;
        }
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
