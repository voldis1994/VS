/**
 * Entry engine orchestrator — Tick Micro + plan context → state → score.
 * Default mode SHADOW. Live EntryReady only when state=ENTRY_READY and mode LIVE/PAPER.
 * Best Outcome EXIT is untouched.
 *
 * Path:
 *   accepted tick → TickMicro update → Entry State Machine evaluation (per-tick)
 * Execution still goes through C++/risk/moneyPath — this module never places orders.
 */

import { regimeEntryPlan, type EntryPlan } from './regimeEntryPlan.js';
import {
  getTickMicroBook,
  ingestValidatedTick,
  type TickMicroMetrics,
  type ValidatedTick,
} from './tickMicroEngine.js';
import {
  advanceEntryMachine,
  getEntryEngineMode,
  getEntryMachine,
  markEntryConsumed,
  type EntryMachineSnapshot,
} from './entryStateMachine.js';
import { computeOpportunityScore, type OpportunityBreakdown } from './entryOpportunity.js';
import { recordEntryCandidate } from './entryOutcomeStore.js';

export type EntryEngineResult = {
  mode: ReturnType<typeof getEntryEngineMode>;
  machine: EntryMachineSnapshot;
  micro: TickMicroMetrics;
  plan: EntryPlan;
  score: OpportunityBreakdown | null;
  /** True when live/paper may proceed to C++/execution */
  allow_entry_ready: boolean;
  shadow_only: boolean;
};

/** Context published by robotDesk so per-tick advance can run between desk cycles. */
export type EntryTickContext = {
  instrument: string;
  regime?: string | null;
  bias?: string | null;
  feedMid?: number | null;
  bars10s: Array<{ open: number; high: number; low: number; close: number }>;
  bars1m?: Array<{ open: number; high: number; low: number; close: number }>;
  feedAgreement?: string | null;
  spreadBlock?: boolean;
  marketOpen?: boolean;
};

const tickContexts = new Map<string, EntryTickContext>();
/** Last recorded (state|phase|kind) — avoid outcome spam on every tick while ARMED. */
const lastRecordedKey = new Map<string, string>();

export function publishEntryTickContext(ctx: EntryTickContext): void {
  const key = String(ctx.instrument || '').toUpperCase();
  if (!key) return;
  tickContexts.set(key, { ...ctx, instrument: key });
}

export function getEntryTickContext(instrument: string): EntryTickContext | null {
  return tickContexts.get(String(instrument || '').toUpperCase()) || null;
}

/** Test helper */
export function resetEntryTickContexts(): void {
  tickContexts.clear();
  lastRecordedKey.clear();
}

export function onValidatedQuoteTick(input: {
  instrument: string;
  mid: number;
  bid?: number | null;
  ask?: number | null;
  quality?: ValidatedTick['quality'];
  provider?: string;
  tsMs?: number;
}): TickMicroMetrics {
  const book = getTickMicroBook(input.instrument);
  const bid = input.bid ?? null;
  const ask = input.ask ?? null;
  const spread =
    bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask)
      ? Math.max(ask - bid, 0)
      : null;
  const tick: ValidatedTick = {
    ts_ms: input.tsMs ?? Date.now(),
    mid: input.mid,
    bid,
    ask,
    spread,
    quality: input.quality ?? 'OK',
    provider: input.provider || 'capital',
  };
  return ingestValidatedTick(book, tick);
}

function buildResult(input: {
  instrument: string;
  liveMid: number | null;
  feedMid?: number | null;
  regime?: string | null;
  bias?: string | null;
  bars10s: Array<{ open: number; high: number; low: number; close: number }>;
  bars1m?: Array<{ open: number; high: number; low: number; close: number }>;
  feedAgreement?: string | null;
  spreadBlock?: boolean;
  marketOpen?: boolean;
  nowMs?: number;
  /** When true, only record candidate if state/phase/kind changed (per-tick path). */
  recordOnChangeOnly?: boolean;
}): EntryEngineResult {
  const mode = getEntryEngineMode();
  const plan = regimeEntryPlan({
    regime: input.regime,
    bias: input.bias,
    liveMid: input.liveMid,
    feedMid: input.feedMid,
    bars10s: input.bars10s,
    bars1m: input.bars1m,
  });
  const micro = getTickMicroBook(input.instrument).metrics;
  const machine = advanceEntryMachine({
    instrument: input.instrument,
    plan,
    mid: input.liveMid,
    micro,
    regime: input.regime,
    feedAgreement: input.feedAgreement,
    spreadBlock: input.spreadBlock,
    marketOpen: input.marketOpen,
    nowMs: input.nowMs,
  });

  let score: OpportunityBreakdown | null = null;
  if (machine.direction) {
    score = computeOpportunityScore({
      plan,
      micro,
      location: machine.location,
      phase: machine.phase,
      kind: machine.kind,
      side: machine.direction,
      feedAgreement: input.feedAgreement,
    });
    machine.opportunity_score = score.total;
  }

  const ready = machine.state === 'ENTRY_READY' && !machine.hard_block;
  const shadow_only = mode === 'SHADOW' || mode === 'OFF';
  const allow_entry_ready = ready && (mode === 'LIVE' || mode === 'PAPER');

  const shouldConsiderRecord =
    machine.state === 'ENTRY_READY' ||
    machine.state === 'TOO_LATE' ||
    machine.state === 'ARMED' ||
    machine.state === 'INVALIDATED' ||
    machine.state === 'TRIGGERING';

  if (shouldConsiderRecord) {
    const key = `${machine.state}|${machine.phase}|${machine.kind || ''}`;
    const prev = lastRecordedKey.get(String(input.instrument || '').toUpperCase());
    const changed = prev !== key;
    if (!input.recordOnChangeOnly || changed) {
      lastRecordedKey.set(String(input.instrument || '').toUpperCase(), key);
      const tag = allow_entry_ready ? 'ENTER' : mode === 'SHADOW' ? 'SHADOW' : 'SKIP';
      recordEntryCandidate({
        instrument: input.instrument,
        machine,
        plan,
        micro,
        score,
        mid: input.liveMid,
        regime: input.regime,
        entryOrSkip: machine.state === 'ENTRY_READY' ? tag : 'SKIP',
        reason: machine.reason,
      });
    }
  }

  return {
    mode,
    machine,
    micro,
    plan,
    score,
    allow_entry_ready,
    shadow_only,
  };
}

export function evaluateEntryEngine(input: {
  instrument: string;
  regime?: string | null;
  bias?: string | null;
  liveMid: number | null;
  feedMid?: number | null;
  bars10s: Array<{ open: number; high: number; low: number; close: number }>;
  bars1m?: Array<{ open: number; high: number; low: number; close: number }>;
  feedAgreement?: string | null;
  spreadBlock?: boolean;
  marketOpen?: boolean;
  nowMs?: number;
}): EntryEngineResult {
  // Keep per-tick path armed with latest desk context (bars/regime/feeds).
  publishEntryTickContext({
    instrument: input.instrument,
    regime: input.regime,
    bias: input.bias,
    feedMid: input.feedMid,
    bars10s: input.bars10s,
    bars1m: input.bars1m,
    feedAgreement: input.feedAgreement,
    spreadBlock: input.spreadBlock,
    marketOpen: input.marketOpen,
  });

  return buildResult({ ...input, recordOnChangeOnly: false });
}

/**
 * Advance Entry State Machine on an accepted validated tick (between desk cycles).
 * Does NOT place broker orders — execution remains C++/risk/moneyPath via robotDesk.
 * Returns null if desk has not yet published context for this instrument.
 */
export function advanceEntryEngineOnAcceptedTick(input: {
  instrument: string;
  mid: number | null;
  nowMs?: number;
}): EntryEngineResult | null {
  const ctx = getEntryTickContext(input.instrument);
  if (!ctx) return null;
  return buildResult({
    instrument: ctx.instrument,
    regime: ctx.regime,
    bias: ctx.bias,
    liveMid: input.mid,
    feedMid: ctx.feedMid,
    bars10s: ctx.bars10s,
    bars1m: ctx.bars1m,
    feedAgreement: ctx.feedAgreement,
    spreadBlock: ctx.spreadBlock,
    marketOpen: ctx.marketOpen,
    nowMs: input.nowMs,
    recordOnChangeOnly: true,
  });
}

export function consumeEntryReady(instrument: string): void {
  markEntryConsumed(instrument);
}

export { getEntryEngineMode, getEntryMachine };
