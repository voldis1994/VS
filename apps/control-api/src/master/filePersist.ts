/**
 * File-backed persist for MASTER_STANDALONE (no Postgres).
 * Same recovery contract as DB tables — open positions + seen intents + journal.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ManagedPosition } from './positionManager.js';
import type { OpportunityRecord, TradeOutcome } from './types.js';
import {
  MemoryPersist,
  setPersistClient,
  type PersistClient,
} from './persist.js';

export type FilePersistState = {
  opportunities: OpportunityRecord[];
  outcomes: Array<{
    opportunity_id: string;
    outcome: TradeOutcome;
    setup_key?: string | null;
    /** ISO timestamp — required so restart daily_pnl does not treat history as today */
    created_at?: string;
  }>;
  positions: ManagedPosition[];
  intents: string[];
};

export class FilePersist implements PersistClient {
  private mem = new MemoryPersist();

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.load();
  }

  private statePath() {
    return join(this.root, 'master_state.json');
  }

  private load() {
    const path = this.statePath();
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as FilePersistState;
      this.mem.positions = (raw.positions || []).map((p) => ({
        position_id: p.position_id,
        opportunity_id: p.opportunity_id,
        intent_id: p.intent_id,
        epic: p.epic,
        side: p.side,
        size: p.size,
        entry: p.entry,
        entry_at: p.entry_at,
        stop_loss: p.stop_loss,
        take_profit: p.take_profit,
        mfe: p.mfe,
        mae: p.mae,
        regime_at_entry: p.regime_at_entry,
        payload: {
          decision: p.decision,
          partial_close_applied: !!p.partial_close_applied,
          multi_tp_levels: p.multi_tp_levels ?? null,
        },
      }));
      this.mem.intents = new Set(raw.intents || []);
      this.mem.opportunities = (raw.opportunities || []).map((o) => ({
        id: o.id,
        created_at: o.ts,
        mode: o.mode,
        epic: o.epic,
        executed: o.executed,
        payload: {
          decision: o.decision,
          risk: o.risk,
          execution: o.execution ?? null,
          outcome: o.outcome,
        },
      }));
      this.mem.outcomes = (raw.outcomes || []).map((o) => ({
        id: o.opportunity_id,
        opportunity_id: o.opportunity_id,
        position_id: o.outcome.position_id || o.opportunity_id,
        side: o.outcome.side,
        entry_price: o.outcome.entry,
        exit_price: o.outcome.exit,
        volume: o.outcome.volume,
        pnl: o.outcome.pnl,
        fees: o.outcome.fees,
        slippage: o.outcome.slippage,
        mae: o.outcome.mae,
        mfe: o.outcome.mfe,
        r_multiple: o.outcome.r_multiple,
        hold_ms: o.outcome.hold_ms,
        exit_reason: o.outcome.exit_reason,
        setup_key: o.setup_key ?? null,
        // Preserve disk timestamp; missing → epoch so recover never counts as "today"
        created_at: o.created_at || '1970-01-01T00:00:00.000Z',
      }));
    } catch {
      /* start clean */
    }
  }

  flush() {
    const state: FilePersistState = {
      opportunities: this.mem.opportunities
        .filter((o) => o.payload?.decision && o.payload?.risk)
        .map((o) => ({
          id: String(o.id),
          ts: new Date(o.created_at).toISOString(),
          mode: o.mode,
          epic: o.epic,
          decision: o.payload.decision,
          risk: o.payload.risk,
          executed: !!o.executed,
          execution: o.payload.execution,
          outcome: o.payload.outcome,
        })),
      outcomes: this.mem.outcomes.map((o) => ({
        opportunity_id: String(o.opportunity_id),
        setup_key: o.setup_key ?? null,
        created_at: o.created_at ? String(o.created_at) : new Date().toISOString(),
        outcome: {
          position_id: String(o.position_id || o.opportunity_id),
          side: o.side,
          entry: Number(o.entry_price),
          exit: Number(o.exit_price),
          volume: Number(o.volume),
          pnl: Number(o.pnl),
          fees: Number(o.fees) || 0,
          slippage: Number(o.slippage) || 0,
          mae: Number(o.mae) || 0,
          mfe: Number(o.mfe) || 0,
          r_multiple: Number(o.r_multiple) || 0,
          hold_ms: Number(o.hold_ms) || 0,
          exit_reason: String(o.exit_reason || ''),
        },
      })),
      positions: (this.mem.positions || []).map((p: any) => ({
        position_id: p.position_id,
        opportunity_id: p.opportunity_id,
        intent_id: p.intent_id,
        epic: p.epic,
        side: p.side,
        size: p.size,
        entry: p.entry,
        entry_at: p.entry_at,
        stop_loss: p.stop_loss,
        take_profit: p.take_profit,
        mfe: p.mfe,
        mae: p.mae,
        regime_at_entry: p.regime_at_entry,
        decision: p.payload?.decision || p.decision,
        partial_close_applied: !!(
          p.partial_close_applied ?? p.payload?.partial_close_applied
        ),
        multi_tp_levels: p.multi_tp_levels ?? p.payload?.multi_tp_levels ?? undefined,
      })),
      intents: [...this.mem.intents],
    };
    writeFileSync(this.statePath(), JSON.stringify(state, null, 2));
  }

  async query(sql: string, params: unknown[] = []) {
    const result = await this.mem.query(sql, params);
    if (/INSERT|UPDATE|DELETE/i.test(sql)) {
      this.flush();
    }
    return result;
  }
}

/** Install file persist when standalone / explicitly requested. */
export function installFilePersist(root?: string): FilePersist {
  const dir =
    root ||
    process.env.MASTER_STATE_DIR ||
    join(process.cwd(), '.master-state');
  const fp = new FilePersist(dir);
  setPersistClient(fp);
  return fp;
}
