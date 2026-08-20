/**
 * Entry engine orchestrator — Tick Micro + plan context → state → score → setup SL.
 * Default mode SHADOW (research). LIVE/PAPER: EntryReady only when state=ENTRY_READY
 * AND setup-specific technical stop is ok (not STOP_TOO_WIDE).
 * Best Outcome EXIT is untouched.
 *
 * Path:
 *   accepted tick → TickMicro → Entry SM → setup technical stop
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
import {
  computeSetupTechnicalStop,
  type SetupStopPlan,
} from './setupTechnicalStop.js';

export type EntryEngineResult = {
  mode: ReturnType<typeof getEntryEngineMode>;
  machine: EntryMachineSnapshot;
  micro: TickMicroMetrics;
  plan: EntryPlan;
  score: OpportunityBreakdown | null;
  /** Setup-specific SL plan — required before live EntryReady */
  stop: SetupStopPlan | null;
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
  bid?: number | null;
  ask?: number | null;
  spread?: number | null;
  bars10s: Array<{ open: number; high: number; low: number; close: number }>;
  bars1m?: Array<{ open: number; high: number; low: number; close: number }>;
  feedAgreement?: string | null;
  spreadBlock?: boolean;
  marketOpen?: boolean;
  baseLot?: number;
};

const tickContexts = new Map<string, EntryTickContext>();
/** Last recorded (state|phase|kind|stopBlock) — avoid outcome spam on every tick while ARMED. */
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

function buildStopPlan(input: {
  machine: EntryMachineSnapshot;
  plan: EntryPlan;
  micro: TickMicroMetrics;
  liveMid: number | null;
  bid?: number | null;
  ask?: number | null;
  spread?: number | null;
  bars10s: Array<{ open: number; high: number; low: number; close: number }>;
  baseLot?: number;
}): SetupStopPlan | null {
  if (!input.machine.direction || !input.machine.kind) return null;
  if (
    input.machine.state !== 'ENTRY_READY' &&
    input.machine.state !== 'TRIGGERING' &&
    input.machine.state !== 'ARMED'
  ) {
    return null;
  }
  const spread =
    input.spread ??
    (input.bid != null &&
    input.ask != null &&
    Number.isFinite(input.bid) &&
    Number.isFinite(input.ask)
      ? Math.max(input.ask - input.bid, 0)
      : input.micro.spread);

  return computeSetupTechnicalStop({
    side: input.machine.direction,
    kind: input.machine.kind,
    mid: input.liveMid,
    bid: input.bid,
    ask: input.ask,
    spread,
    bars10s: input.bars10s,
    micro: input.micro,
    move_start_mid: input.machine.move_start_mid,
    plan_entry: input.plan.targets.entry,
    plan_invalidation: input.plan.targets.invalidation,
    range_high: input.plan.targets.range_high,
    range_low: input.plan.targets.range_low,
    break_level: input.plan.targets.break_level,
    confirm_level: input.plan.targets.confirm_level,
    baseLot: input.baseLot,
  });
}

function buildResult(input: {
  instrument: string;
  liveMid: number | null;
  feedMid?: number | null;
  bid?: number | null;
  ask?: number | null;
  spread?: number | null;
  regime?: string | null;
  bias?: string | null;
  bars10s: Array<{ open: number; high: number; low: number; close: number }>;
  bars1m?: Array<{ open: number; high: number; low: number; close: number }>;
  feedAgreement?: string | null;
  spreadBlock?: boolean;
  marketOpen?: boolean;
  nowMs?: number;
  baseLot?: number;
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

  const stop = buildStopPlan({
    machine,
    plan,
    micro,
    liveMid: input.liveMid,
    bid: input.bid,
    ask: input.ask,
    spread: input.spread,
    bars10s: input.bars10s,
    baseLot: input.baseLot,
  });

  // EntryReady requires setup-specific SL. Far / missing structure → demote, never pull SL closer.
  if (machine.state === 'ENTRY_READY' && stop && !stop.ok) {
    machine.hard_block = stop.block || 'STOP_TOO_WIDE';
    machine.reason = stop.reason;
    // Stay visible as TRIGGERING with block — not live ready
    machine.state = 'TRIGGERING';
  }

  const ready =
    machine.state === 'ENTRY_READY' && !machine.hard_block && !!stop?.ok;
  const shadow_only = mode === 'SHADOW' || mode === 'OFF';
  const allow_entry_ready = ready && (mode === 'LIVE' || mode === 'PAPER');

  const shouldConsiderRecord =
    machine.state === 'ENTRY_READY' ||
    machine.state === 'TOO_LATE' ||
    machine.state === 'ARMED' ||
    machine.state === 'INVALIDATED' ||
    machine.state === 'TRIGGERING' ||
    (stop != null && !stop.ok);

  if (shouldConsiderRecord) {
    const key = `${machine.state}|${machine.phase}|${machine.kind || ''}|${stop?.block || ''}`;
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
        reason: stop && !stop.ok ? stop.reason : machine.reason,
      });
    }
  }

  return {
    mode,
    machine,
    micro,
    plan,
    score,
    stop,
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
  bid?: number | null;
  ask?: number | null;
  spread?: number | null;
  bars10s: Array<{ open: number; high: number; low: number; close: number }>;
  bars1m?: Array<{ open: number; high: number; low: number; close: number }>;
  feedAgreement?: string | null;
  spreadBlock?: boolean;
  marketOpen?: boolean;
  nowMs?: number;
  baseLot?: number;
}): EntryEngineResult {
  publishEntryTickContext({
    instrument: input.instrument,
    regime: input.regime,
    bias: input.bias,
    feedMid: input.feedMid,
    bid: input.bid,
    ask: input.ask,
    spread: input.spread,
    bars10s: input.bars10s,
    bars1m: input.bars1m,
    feedAgreement: input.feedAgreement,
    spreadBlock: input.spreadBlock,
    marketOpen: input.marketOpen,
    baseLot: input.baseLot,
  });

  return buildResult({ ...input, recordOnChangeOnly: false });
}

/**
 * Advance Entry State Machine on an accepted validated tick (between desk cycles).
 * Does NOT place broker orders — execution remains C++/risk/moneyPath via robotDesk.
 */
export function advanceEntryEngineOnAcceptedTick(input: {
  instrument: string;
  mid: number | null;
  bid?: number | null;
  ask?: number | null;
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
    bid: input.bid ?? ctx.bid,
    ask: input.ask ?? ctx.ask,
    spread: ctx.spread,
    bars10s: ctx.bars10s,
    bars1m: ctx.bars1m,
    feedAgreement: ctx.feedAgreement,
    spreadBlock: ctx.spreadBlock,
    marketOpen: ctx.marketOpen,
    baseLot: ctx.baseLot,
    nowMs: input.nowMs,
    recordOnChangeOnly: true,
  });
}

export function consumeEntryReady(instrument: string): void {
  markEntryConsumed(instrument);
}

export { getEntryEngineMode, getEntryMachine };
