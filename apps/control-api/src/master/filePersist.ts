/**
 * File-backed persist for MASTER_STANDALONE (no Postgres).
 * Same recovery contract as DB tables — open positions + seen intents + journal.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ManagedPosition } from './positionManager.js';
import type { OpportunityRecord, TradeOutcome } from './types.js';
import {
  MemoryPersist,
  setPersistClient,
  type PersistClient,
} from './persist.js';
import { atomicWriteJson } from './atomicIo.js';
import type { MarketCacheState } from './marketCache.js';
import type { DecisionEvent } from './decisionJournal.js';
import type { TradeEvent } from './tradeEventJournal.js';
import { setJournalMirror, type JournalMirror } from './journalMirror.js';

const MAX_MIRRORED_JOURNAL = 500;

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
  /** Reader audit tails — survive jsonl sidecar wipe under DualPersist mirror */
  decision_events?: DecisionEvent[];
  trade_events?: TradeEvent[];
  /** Manage/owns/gates/market_cache/epic_cycle_stash — survive with positions when sidecar JSON is wiped */
  operator_meta?: {
    manage?: Record<string, unknown> | null;
    owns_pipeline?: boolean | null;
    gates?: Record<string, unknown> | null;
    /** Compact OHLC+quote — PG path / sidecar wipe must not leave manage blind */
    market_cache?: MarketCacheState | null;
    /** Per-epic SETUP + cycle evidence across restart */
    epic_cycle_stash?: import('./epicCycleStash.js').EpicCycleStashState | null;
  };
};

export class FilePersist implements PersistClient, JournalMirror {
  private mem = new MemoryPersist();
  /** Last known operator_meta from disk — survives sidecar wipe mid-process. */
  private lastOperatorMeta: FilePersistState['operator_meta'] | undefined;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.load();
    setJournalMirror(this);
  }

  appendDecision(entry: DecisionEvent): void {
    this.mem.decisionEvents.push(entry);
    if (this.mem.decisionEvents.length > MAX_MIRRORED_JOURNAL) {
      this.mem.decisionEvents = this.mem.decisionEvents.slice(
        -MAX_MIRRORED_JOURNAL
      );
    }
    this.flush();
  }

  appendTrade(entry: TradeEvent): void {
    this.mem.tradeEvents.push(entry);
    if (this.mem.tradeEvents.length > MAX_MIRRORED_JOURNAL) {
      this.mem.tradeEvents = this.mem.tradeEvents.slice(-MAX_MIRRORED_JOURNAL);
    }
    this.flush();
  }

  loadDecisions(limit: number): DecisionEvent[] {
    return [...this.mem.decisionEvents]
      .reverse()
      .slice(0, Math.max(0, limit)) as DecisionEvent[];
  }

  loadTrades(limit: number): TradeEvent[] {
    return [...this.mem.tradeEvents]
      .reverse()
      .slice(0, Math.max(0, limit)) as TradeEvent[];
  }

  /** Rewrite missing decision/trade jsonl from mirrored master_state tails. */
  restoreJournalSidecars(): boolean {
    let wrote = false;
    try {
      const decPath = join(this.root, 'decision_journal.jsonl');
      if (!existsSync(decPath) && this.mem.decisionEvents.length) {
        writeFileSync(
          decPath,
          `${this.mem.decisionEvents.map((e) => JSON.stringify(e)).join('\n')}\n`,
          'utf8'
        );
        wrote = true;
      }
      const tradePath = join(this.root, 'trade_event_journal.jsonl');
      if (!existsSync(tradePath) && this.mem.tradeEvents.length) {
        writeFileSync(
          tradePath,
          `${this.mem.tradeEvents.map((e) => JSON.stringify(e)).join('\n')}\n`,
          'utf8'
        );
        wrote = true;
      }
    } catch {
      return false;
    }
    return wrote;
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
          playbook_at_entry: (p as ManagedPosition).playbook_at_entry ?? null,
          entry_setup: (p as ManagedPosition).entry_setup ?? null,
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
        // Survive restart — recover daily_pnl/streak must skip unproven Capital closes
        pnl_proven:
          o.outcome.pnl_proven === false
            ? false
            : o.outcome.pnl_proven === true
              ? true
              : undefined,
        setup_key: o.setup_key ?? null,
        // Preserve disk timestamp; missing → epoch so recover never counts as "today"
        created_at: o.created_at || '1970-01-01T00:00:00.000Z',
      }));
      // Restore operator knobs into sidecar files when missing (PG-only recovery hole)
      if (raw.operator_meta) {
        this.lastOperatorMeta = raw.operator_meta;
        this.restoreOperatorMeta(raw.operator_meta);
      }
      if (Array.isArray(raw.decision_events)) {
        this.mem.decisionEvents = raw.decision_events.slice(
          -MAX_MIRRORED_JOURNAL
        );
      }
      if (Array.isArray(raw.trade_events)) {
        this.mem.tradeEvents = raw.trade_events.slice(-MAX_MIRRORED_JOURNAL);
      }
      this.restoreJournalSidecars();
    } catch {
      /* start clean */
    }
  }

  /** Re-read master_state.json and restore missing sidecar JSON files. */
  ensureOperatorMetaFromState(): boolean {
    try {
      const path = this.statePath();
      if (!existsSync(path)) {
        if (this.lastOperatorMeta) {
          this.restoreOperatorMeta(this.lastOperatorMeta);
          return true;
        }
        return false;
      }
      const raw = JSON.parse(readFileSync(path, 'utf8')) as FilePersistState;
      if (raw.operator_meta) {
        this.lastOperatorMeta = raw.operator_meta;
        this.restoreOperatorMeta(raw.operator_meta);
        return true;
      }
      if (this.lastOperatorMeta) {
        this.restoreOperatorMeta(this.lastOperatorMeta);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private restoreOperatorMeta(
    meta: FilePersistState['operator_meta'] | undefined
  ) {
    if (!meta) return;
    try {
      const needsRestore = (path: string): boolean => {
        if (!existsSync(path)) return true;
        try {
          JSON.parse(readFileSync(path, 'utf8'));
          return false;
        } catch {
          return true; // corrupt — heal from operator_meta
        }
      };
      const managePath = join(this.root, 'master_manage_config.json');
      if (meta.manage && needsRestore(managePath)) {
        atomicWriteJson(managePath, meta.manage);
      }
      const ownsPath = join(this.root, 'owns_pipeline.json');
      if (typeof meta.owns_pipeline === 'boolean' && needsRestore(ownsPath)) {
        atomicWriteJson(ownsPath, { owns_pipeline: meta.owns_pipeline });
      }
      const gatesPath = join(this.root, 'runtime_gates.json');
      if (meta.gates && needsRestore(gatesPath)) {
        atomicWriteJson(gatesPath, meta.gates);
      }
      const cachePath = join(this.root, 'market_cache.json');
      if (meta.market_cache && needsRestore(cachePath)) {
        atomicWriteJson(cachePath, meta.market_cache);
      }
      const epicStashPath = join(this.root, 'epic_cycle_stash.json');
      if (meta.epic_cycle_stash && needsRestore(epicStashPath)) {
        atomicWriteJson(epicStashPath, meta.epic_cycle_stash);
      }
    } catch {
      /* best-effort */
    }
  }

  private snapshotOperatorMeta(): FilePersistState['operator_meta'] {
    const readJson = (name: string): Record<string, unknown> | null => {
      try {
        const p = join(this.root, name);
        if (!existsSync(p)) return null;
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    const manageRaw = readJson('master_manage_config.json');
    const ownsRaw = readJson('owns_pipeline.json');
    const gatesRaw = readJson('runtime_gates.json');
    const marketCacheRaw = readJson('market_cache.json');
    const epicStashRaw = readJson('epic_cycle_stash.json');
    // Per-field fallback: partial sidecar wipe must not null out embedded meta
    const manage =
      manageRaw ?? this.lastOperatorMeta?.manage ?? null;
    const owns =
      ownsRaw && typeof ownsRaw.owns_pipeline === 'boolean'
        ? (ownsRaw.owns_pipeline as boolean)
        : this.lastOperatorMeta?.owns_pipeline ?? null;
    const gates = gatesRaw ?? this.lastOperatorMeta?.gates ?? null;
    const market_cache =
      marketCacheRaw && Array.isArray(marketCacheRaw.bars)
        ? (marketCacheRaw as unknown as MarketCacheState)
        : this.lastOperatorMeta?.market_cache ?? null;
    const epic_cycle_stash =
      epicStashRaw &&
      (epicStashRaw.setups_by_epic || epicStashRaw.cycles_by_epic)
        ? (epicStashRaw as unknown as import('./epicCycleStash.js').EpicCycleStashState)
        : this.lastOperatorMeta?.epic_cycle_stash ?? null;
    if (!manage && owns == null && !gates && !market_cache && !epic_cycle_stash) {
      // Sidecars wiped — keep prior meta so flush does not erase backup
      return this.lastOperatorMeta;
    }
    const meta = {
      manage,
      owns_pipeline: owns,
      gates,
      market_cache,
      epic_cycle_stash,
    };
    this.lastOperatorMeta = meta;
    return meta;
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
          ...(o.pnl_proven === false
            ? { pnl_proven: false as const }
            : o.pnl_proven === true
              ? { pnl_proven: true as const }
              : {}),
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
        soft_trail_armed_at:
          p.soft_trail_armed_at ?? p.payload?.soft_trail_armed_at ?? null,
        soft_trail_peak: p.soft_trail_peak ?? p.payload?.soft_trail_peak ?? null,
        native_trail_armed: !!(
          p.native_trail_armed ?? p.payload?.native_trail_armed
        ),
        scalp_chase_at_ms:
          p.scalp_chase_at_ms ?? p.payload?.scalp_chase_at_ms ?? null,
        ema3_side: (() => {
          const s = p.ema3_side ?? p.payload?.ema3_side ?? null;
          return s === 'above' || s === 'below' ? s : null;
        })(),
        modify_reject_level: (() => {
          const v = p.modify_reject_level ?? p.payload?.modify_reject_level;
          return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
        })(),
        modify_backoff_until_ms: (() => {
          const v =
            p.modify_backoff_until_ms ?? p.payload?.modify_backoff_until_ms;
          return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
        })(),
        intended_stop_loss: (() => {
          const v = p.intended_stop_loss ?? p.payload?.intended_stop_loss;
          return v != null && Number.isFinite(Number(v)) && Number(v) > 0
            ? Number(v)
            : null;
        })(),
        intended_take_profit: (() => {
          const v = p.intended_take_profit ?? p.payload?.intended_take_profit;
          return v != null && Number.isFinite(Number(v)) && Number(v) > 0
            ? Number(v)
            : null;
        })(),
        naked_recovery_level: (() => {
          const v = p.naked_recovery_level ?? p.payload?.naked_recovery_level;
          return v != null && Number.isFinite(Number(v))
            ? Math.max(0, Math.floor(Number(v)))
            : null;
        })(),
        playbook_at_entry: (() => {
          const v = p.playbook_at_entry ?? p.payload?.playbook_at_entry;
          return v === 'LONG' || v === 'SCALP' || v === 'FADE' ? v : undefined;
        })(),
        entry_setup: (() => {
          const v = p.entry_setup ?? p.payload?.entry_setup;
          return typeof v === 'string' && v.trim() ? String(v) : undefined;
        })(),
      })),
      intents: [...this.mem.intents],
      decision_events: this.mem.decisionEvents.slice(-MAX_MIRRORED_JOURNAL),
      trade_events: this.mem.tradeEvents.slice(-MAX_MIRRORED_JOURNAL),
      operator_meta: this.snapshotOperatorMeta(),
    };
    atomicWriteJson(this.statePath(), state);
    // Dual-write market_cache sidecar when SQL path updated MemoryPersist
    if (this.mem.marketCachePayload) {
      atomicWriteJson(
        join(this.root, 'market_cache.json'),
        this.mem.marketCachePayload
      );
    }
    // Dual-write epic_cycle_stash sidecar when SQL path updated MemoryPersist
    if (this.mem.epicCycleStashPayload) {
      atomicWriteJson(
        join(this.root, 'epic_cycle_stash.json'),
        this.mem.epicCycleStashPayload
      );
    }
    // Dual-write runtime_gates sidecar when SQL path updated MemoryPersist
    if (this.mem.runtimeGatesPayload) {
      atomicWriteJson(
        join(this.root, 'runtime_gates.json'),
        this.mem.runtimeGatesPayload
      );
    }
    // Dual-write manage_config sidecar when SQL path updated MemoryPersist
    if (this.mem.manageConfigPayload) {
      atomicWriteJson(
        join(this.root, 'master_manage_config.json'),
        this.mem.manageConfigPayload
      );
    }
    // Dual-write owns_pipeline sidecar when SQL path updated MemoryPersist
    if (this.mem.ownsPipelinePayload) {
      atomicWriteJson(join(this.root, 'owns_pipeline.json'), {
        owns_pipeline: this.mem.ownsPipelinePayload.owns_pipeline === true,
      });
    }
    // Dual-write monitoring_snapshot sidecar when SQL path updated MemoryPersist
    if (this.mem.monitoringSnapshotPayload) {
      atomicWriteJson(
        join(this.root, 'monitoring_snapshot.json'),
        this.mem.monitoringSnapshotPayload
      );
    }
    // Dual-write spread_history sidecar when SQL path updated MemoryPersist
    if (this.mem.spreadHistoryPayload) {
      atomicWriteJson(
        join(this.root, 'spread_history.json'),
        this.mem.spreadHistoryPayload
      );
    }
    // Dual-write trade_ack_journal sidecar when SQL path updated MemoryPersist
    if (this.mem.tradeAckJournalPayload) {
      const records =
        this.mem.tradeAckJournalPayload.records &&
        typeof this.mem.tradeAckJournalPayload.records === 'object'
          ? this.mem.tradeAckJournalPayload.records
          : this.mem.tradeAckJournalPayload;
      atomicWriteJson(join(this.root, 'trade_ack_journal.json'), records);
    }
    // Dual-write error_journal.jsonl when SQL path updated MemoryPersist
    if (
      this.mem.errorJournalPayload &&
      Array.isArray(this.mem.errorJournalPayload.entries)
    ) {
      const lines = this.mem.errorJournalPayload.entries
        .map((e: unknown) => JSON.stringify(e))
        .join('\n');
      const path = join(this.root, 'error_journal.jsonl');
      const body = lines ? `${lines}\n` : '';
      writeFileSync(path, body, 'utf8');
    }
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

/** Restore decision/trade jsonl from master_state mirror when sidecars were wiped. */
export function ensureJournalSidecarsFromStateDir(root?: string): boolean {
  const dir =
    root ||
    process.env.MASTER_STATE_DIR ||
    join(process.cwd(), '.master-state');
  try {
    const path = join(dir, 'master_state.json');
    if (!existsSync(path)) return false;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as FilePersistState;
    let wrote = false;
    const decPath = join(dir, 'decision_journal.jsonl');
    if (
      !existsSync(decPath) &&
      Array.isArray(raw.decision_events) &&
      raw.decision_events.length
    ) {
      writeFileSync(
        decPath,
        `${raw.decision_events.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf8'
      );
      wrote = true;
    }
    const tradePath = join(dir, 'trade_event_journal.jsonl');
    if (
      !existsSync(tradePath) &&
      Array.isArray(raw.trade_events) &&
      raw.trade_events.length
    ) {
      writeFileSync(
        tradePath,
        `${raw.trade_events.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf8'
      );
      wrote = true;
    }
    return wrote;
  } catch {
    return false;
  }
}

/**
 * Before recover hydrate: restore manage/owns/gates/market_cache sidecars from
 * master_state.json when they were wiped mid-process (DualPersist mirror or
 * standalone FilePersist).
 */
export function ensureOperatorMetaFromStateDir(root?: string): boolean {
  const dir =
    root ||
    process.env.MASTER_STATE_DIR ||
    join(process.cwd(), '.master-state');
  try {
    const path = join(dir, 'master_state.json');
    if (!existsSync(path)) return false;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as FilePersistState;
    if (!raw.operator_meta) return false;
    const needsRestore = (p: string): boolean => {
      if (!existsSync(p)) return true;
      try {
        JSON.parse(readFileSync(p, 'utf8'));
        return false;
      } catch {
        return true;
      }
    };
    const managePath = join(dir, 'master_manage_config.json');
    if (raw.operator_meta.manage && needsRestore(managePath)) {
      atomicWriteJson(managePath, raw.operator_meta.manage);
    }
    const ownsPath = join(dir, 'owns_pipeline.json');
    if (
      typeof raw.operator_meta.owns_pipeline === 'boolean' &&
      needsRestore(ownsPath)
    ) {
      atomicWriteJson(ownsPath, {
        owns_pipeline: raw.operator_meta.owns_pipeline,
      });
    }
    const gatesPath = join(dir, 'runtime_gates.json');
    if (raw.operator_meta.gates && needsRestore(gatesPath)) {
      atomicWriteJson(gatesPath, raw.operator_meta.gates);
    }
    const cachePath = join(dir, 'market_cache.json');
    if (raw.operator_meta.market_cache && needsRestore(cachePath)) {
      atomicWriteJson(cachePath, raw.operator_meta.market_cache);
    }
    const epicStashPath = join(dir, 'epic_cycle_stash.json');
    if (raw.operator_meta.epic_cycle_stash && needsRestore(epicStashPath)) {
      atomicWriteJson(epicStashPath, raw.operator_meta.epic_cycle_stash);
    }
    // Also heal wiped decision/trade jsonl from mirrored tails
    ensureJournalSidecarsFromStateDir(dir);
    return true;
  } catch {
    return false;
  }
}
