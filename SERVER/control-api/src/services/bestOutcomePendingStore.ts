/**
 * Pending Best Outcome exit snapshots — evaluated when the next VALID Strategy signal arrives.
 * Does not retroactively change Capital close; scores prior EXIT quality only.
 */

import {
  evaluateBestOutcomeQuality,
  computeRetention,
  type BestOutcomeQualityResult,
} from './bestOutcomeQuality.js';
import type { CrossMarketPressure } from './crossMarketPressure.js';
import type { MultiFeedPrice } from './robotReader.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import type { ExitSide } from './exitManage.js';
import type { BestOutcomeStateName } from './exitManage.js';

export type BestOutcomeExitSnapshot = {
  robot_id: string;
  account_id: number;
  epic: string;
  previous_side: ExitSide;
  entry_price: number;
  exit_price: number;
  mfe: number;
  upl_at_exit: number;
  retention: number | null;
  exit_at: string;
  best_outcome_reason: string | null;
  best_outcome_state: BestOutcomeStateName | null;
  entry_setup: string | null;
  entry_regime: string | null;
  evaluated: boolean;
  next_side?: ExitSide | null;
  evaluation?: BestOutcomeQualityResult | null;
  evaluated_at?: string | null;
};

const pendingByKey = new Map<string, BestOutcomeExitSnapshot>();
const lastEvaluatedByKey = new Map<string, BestOutcomeQualityResult>();

function storeKey(accountId: number, epic: string): string {
  return `${accountId}:${String(epic || '').trim().toUpperCase()}`;
}

export function saveBestOutcomeExitSnapshot(snapshot: Omit<BestOutcomeExitSnapshot, 'evaluated'>): void {
  const key = storeKey(snapshot.account_id, snapshot.epic);
  pendingByKey.set(key, {
    ...snapshot,
    evaluated: false,
    evaluation: null,
    evaluated_at: null,
  });
}

export function getPendingBestOutcomeSnapshot(
  accountId: number,
  epic: string
): BestOutcomeExitSnapshot | null {
  return pendingByKey.get(storeKey(accountId, epic)) ?? null;
}

export function getLastBestOutcomeEvaluation(
  accountId: number,
  epic: string
): BestOutcomeQualityResult | null {
  return lastEvaluatedByKey.get(storeKey(accountId, epic)) ?? null;
}

/** Clear store — test helper. */
export function resetBestOutcomePendingStore(): void {
  pendingByKey.clear();
  lastEvaluatedByKey.clear();
}

export type ValidNextSignalInput = {
  account_id: number;
  epic: string;
  next_side: ExitSide;
  closedBars?: TenSecBar[] | null;
  feed?: MultiFeedPrice | null;
  crossMarket?: CrossMarketPressure | null;
  regime?: string | null;
  bias?: string | null;
};

/**
 * Evaluate pending exit snapshot against a VALID Strategy signal.
 * Returns null when no pending snapshot or already evaluated.
 */
export function evaluatePendingWithNextSignal(
  input: ValidNextSignalInput
): BestOutcomeQualityResult | null {
  const key = storeKey(input.account_id, input.epic);
  const pending = pendingByKey.get(key);
  if (!pending || pending.evaluated) return null;

  const evaluation = evaluateBestOutcomeQuality({
    mfe: pending.mfe,
    uplAtExit: pending.upl_at_exit,
    previousSide: pending.previous_side,
    nextSide: input.next_side,
    closedBars: input.closedBars,
    feed: input.feed,
    crossMarket: input.crossMarket,
    regime: input.regime,
    bias: input.bias,
  });

  const updated: BestOutcomeExitSnapshot = {
    ...pending,
    evaluated: true,
    next_side: input.next_side,
    evaluation,
    evaluated_at: new Date().toISOString(),
  };
  pendingByKey.set(key, updated);
  lastEvaluatedByKey.set(key, evaluation);
  return evaluation;
}

/** Build snapshot from robot state at close — called before clearTradeState. */
export function buildExitSnapshotFromClose(input: {
  robot_id: string;
  account_id: number;
  epic: string;
  open_side: ExitSide;
  entry_price: number;
  exit_price: number;
  mfe: number;
  upl_at_exit: number;
  best_outcome_reason: string | null;
  best_outcome_state: BestOutcomeStateName | null;
  entry_setup: string | null;
  entry_regime: string | null;
}): BestOutcomeExitSnapshot {
  return {
    robot_id: input.robot_id,
    account_id: input.account_id,
    epic: input.epic,
    previous_side: input.open_side,
    entry_price: input.entry_price,
    exit_price: input.exit_price,
    mfe: input.mfe,
    upl_at_exit: input.upl_at_exit,
    retention: computeRetention(input.mfe, input.upl_at_exit),
    exit_at: new Date().toISOString(),
    best_outcome_reason: input.best_outcome_reason,
    best_outcome_state: input.best_outcome_state,
    entry_setup: input.entry_setup,
    entry_regime: input.entry_regime,
    evaluated: false,
    evaluation: null,
    evaluated_at: null,
  };
}
