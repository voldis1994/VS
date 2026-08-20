/**
 * Entry engine orchestrator — Tick Micro + plan context → state → score.
 * Default mode SHADOW. Live EntryReady only when state=ENTRY_READY and mode LIVE/PAPER.
 * Best Outcome EXIT is untouched.
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

  // Always record candidates when armed+ (research / missed opportunities)
  if (
    machine.state === 'ENTRY_READY' ||
    machine.state === 'TOO_LATE' ||
    machine.state === 'ARMED' ||
    machine.state === 'INVALIDATED'
  ) {
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

export function consumeEntryReady(instrument: string): void {
  markEntryConsumed(instrument);
}

export { getEntryEngineMode, getEntryMachine };
