/**
 * File-backed persist for MASTER_STANDALONE (no Postgres).
 * Same recovery contract as DB tables — open positions + seen intents + outcomes.
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
  outcomes: Array<{ opportunity_id: string; outcome: TradeOutcome; setup_key?: string | null }>;
  positions: ManagedPosition[];
  intents: string[];
};

export class FilePersist implements PersistClient {
  private mem = new MemoryPersist();
  private dirty = false;

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
        ...p,
        payload: { decision: (p as any).decision },
      })) as any;
      // Normalize for loadOpenPositions SELECT mapping
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
        payload: { decision: p.decision },
      }));
      this.mem.intents = new Set(raw.intents || []);
      this.mem.opportunities = (raw.opportunities || []).map((o) => ({ id: o.id, params: [] }));
      this.mem.outcomes = (raw.outcomes || []).map((o) => ({
        id: o.opportunity_id,
        opportunity_id: o.opportunity_id,
        params: [],
      }));
    } catch {
      /* start clean */
    }
  }

  flush(extra?: Partial<FilePersistState>) {
    const state: FilePersistState = {
      opportunities: extra?.opportunities || [],
      outcomes: extra?.outcomes || [],
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
      })),
      intents: [...this.mem.intents],
    };
    writeFileSync(this.statePath(), JSON.stringify(state, null, 2));
    this.dirty = false;
  }

  async query(sql: string, params: unknown[] = []) {
    const result = await this.mem.query(sql, params);
    this.dirty = true;
    // Persist after mutating writes
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
