/**
 * LIVE Best Outcome exit gate — runs while the position is still OPEN.
 *
 * Old Best Outcome optimization CLOSE becomes an EXIT CANDIDATE.
 * The formula BO = R + α × D × C then decides HOLD vs CLOSE.
 * Hard safety/risk CLOSE is never blocked.
 *
 * MANAGE signal evaluation must NOT open a new Capital order.
 */

import { resolveDeskEntry } from './deskEntry.js';
import { evaluateEntryDirectionGate } from './entryDirectionGate.js';
import type { TrendBias } from './entryFromRegime.js';
import type { CrossMarketPressure } from './crossMarketPressure.js';
import type { MultiFeedPrice } from './robotReader.js';
import type { PriceRef } from './staleQuoteGuard.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import type {
  BestOutcomeEvaluation,
  ExitSide,
} from './exitManage.js';
import {
  LIVE_CONFIRM_STRONG,
  evaluateLiveBestOutcomeQuality,
  type BestOutcomeQualityResult,
} from './bestOutcomeQuality.js';

/** Same stale window as robotDesk / entryDirectionGate C++ EntryReady. */
const CALC_MAX_AGE_MS = 12_000;

export type PendingCalcPeek = {
  direction: 'BUY' | 'SELL';
  setup_type?: string | null;
  explanation?: string | null;
  regime?: string | null;
  at: string;
};

export type LiveManageSignal = {
  direction: ExitSide | null;
  setup: string | null;
  reason: string;
  valid: boolean;
  peeked_pending_calc: boolean;
  consumed_pending_calc: false;
};

export function resolveLiveManageSignal(input: {
  pendingCalc?: PendingCalcPeek | null;
  bar?: TenSecBar | null;
  closedBars?: TenSecBar[] | null;
  regime?: string | null;
  bias?: TrendBias | string | null;
  capitalMid: number | null | undefined;
  refs: PriceRef[];
  nowMs?: number;
}): LiveManageSignal {
  const now = input.nowMs ?? Date.now();
  let intended: 'BUY' | 'SELL' | null = null;
  let setup: string | null = null;
  let reason = '';
  let signalAgeMs: number | null = null;
  let peeked = false;

  if (input.pendingCalc?.direction && input.pendingCalc.at) {
    const age = now - Date.parse(input.pendingCalc.at);
    peeked = true;
    if (Number.isFinite(age) && age >= 0 && age <= CALC_MAX_AGE_MS) {
      intended = input.pendingCalc.direction;
      setup = input.pendingCalc.setup_type ?? null;
      reason = `CALC EntryReady · ${input.pendingCalc.explanation || input.pendingCalc.regime || input.pendingCalc.setup_type || input.pendingCalc.direction}`;
      signalAgeMs = age;
    }
  }

  const resolved = resolveDeskEntry({
    intended,
    intendedSetup: setup,
    intendedReason: reason,
    bar: input.bar,
    regime: input.regime,
    bias: (input.bias as TrendBias) || 'FLAT',
    closedBars: input.closedBars,
    capitalMid: input.capitalMid,
    refs: input.refs || [],
  });

  if (!resolved.direction) {
    return {
      direction: null,
      setup: null,
      reason: resolved.reason || 'no valid live signal',
      valid: false,
      peeked_pending_calc: peeked,
      consumed_pending_calc: false,
    };
  }

  const gate = evaluateEntryDirectionGate({
    direction: resolved.direction,
    closedBars: input.closedBars,
    bar: input.bar,
    regime: input.regime,
    bias: (input.bias as TrendBias) || 'FLAT',
    setup: resolved.setup,
    signalAgeMs,
  });

  if (gate.final_entry !== 'ALLOW') {
    return {
      direction: null,
      setup: resolved.setup,
      reason: gate.block_reason || 'invalid live signal',
      valid: false,
      peeked_pending_calc: peeked,
      consumed_pending_calc: false,
    };
  }

  return {
    direction: resolved.direction,
    setup: resolved.setup,
    reason: resolved.reason,
    valid: true,
    peeked_pending_calc: peeked,
    consumed_pending_calc: false,
  };
}

export type LiveBestOutcomeDecision = BestOutcomeEvaluation & {
  live_quality: BestOutcomeQualityResult;
  live_overridden: boolean;
};

function scoreLabel(q: BestOutcomeQualityResult): string {
  const r = q.retention != null ? q.retention.toFixed(3) : 'n/a';
  const c = q.next_signal_confirm != null ? q.next_signal_confirm.toFixed(2) : 'n/a';
  const bo = q.best_outcome_score != null ? q.best_outcome_score.toFixed(3) : 'n/a';
  return `R=${r} D=${q.next_signal_direction} C=${c} BO=${bo}`;
}

/**
 * Apply LIVE BO formula to an EXIT CANDIDATE before exitTrade().
 *
 * OPEN + strong SAME confirm → HOLD
 * OPEN + strong OPPOSITE confirm → CLOSE
 * Weak/neutral confirm or no valid signal → original MFE/UPL candidate
 * HARD_SAFETY → CLOSE always
 */
export function decideLiveBestOutcomeExit(input: {
  candidate: BestOutcomeEvaluation;
  openSide: ExitSide;
  mfe: number;
  upl: number;
  signal: LiveManageSignal;
  closedBars?: TenSecBar[] | null;
  feed?: MultiFeedPrice | null;
  crossMarket?: CrossMarketPressure | null;
  regime?: string | null;
  bias?: string | null;
}): LiveBestOutcomeDecision {
  const currentSide = input.signal.valid ? input.signal.direction : null;
  const live_quality = evaluateLiveBestOutcomeQuality({
    mfe: input.mfe,
    upl: input.upl,
    openSide: input.openSide,
    currentSide,
    closedBars: input.closedBars,
    feed: input.feed,
    crossMarket: input.crossMarket,
    regime: input.regime,
    bias: input.bias,
  });

  const candidate = input.candidate;

  if (candidate.exit && candidate.exit_kind === 'HARD_SAFETY') {
    return { ...candidate, live_quality, live_overridden: false };
  }

  if (!candidate.exit) {
    return { ...candidate, live_quality, live_overridden: false };
  }

  const d = live_quality.next_signal_direction;
  const c = live_quality.next_signal_confirm;
  const strong = c != null && Number.isFinite(c) && c >= LIVE_CONFIRM_STRONG;

  if (!strong || d === 0) {
    return { ...candidate, live_quality, live_overridden: false };
  }

  if (d === -1) {
    const reason = `LIVE HOLD · same-direction ${input.openSide} · ${scoreLabel(live_quality)} · skip optimization CLOSE (${candidate.reason})`;
    return {
      exit: false,
      action: 'HOLD',
      reason,
      exit_kind: 'NONE',
      track: { ...candidate.track, state: 'HOLD', reason },
      view: {
        ...candidate.view,
        best_outcome_state: 'HOLD',
        best_outcome_reason: reason,
      },
      live_quality,
      live_overridden: true,
    };
  }

  const reason = `LIVE CLOSE · opposite ${currentSide} · ${scoreLabel(live_quality)} · ${candidate.reason}`;
  return {
    ...candidate,
    reason,
    track: { ...candidate.track, reason },
    view: { ...candidate.view, best_outcome_reason: reason },
    live_quality,
    live_overridden: false,
  };
}
