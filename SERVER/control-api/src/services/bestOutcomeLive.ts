/**
 * LIVE Best Outcome exit gate — runs while the position is still OPEN.
 *
 * Formula BO = R + α × D × C drives OPTIMIZATION CLOSE/HOLD.
 * Hard safety CLOSE is never blocked.
 * MANAGE signal evaluation must NOT open a new Capital order.
 */

import { resolveDeskEntry } from './deskEntry.js';
import { evaluateEntryDirectionGate } from './entryDirectionGate.js';
import type { TrendBias } from './entryFromRegime.js';
import type { CrossMarketPressure } from './crossMarketPressure.js';
import type { MultiFeedPrice } from './robotReader.js';
import type { PriceRef } from './staleQuoteGuard.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import type { BestOutcomeEvaluation, ExitSide } from './exitManage.js';
import {
  blockOptimizationCloseIfNotInProfit,
  canOptimizationClose,
} from './exitManage.js';
import {
  LIVE_BO_CLOSE_MIN,
  LIVE_CONFIRM_STRONG,
  evaluateLiveBestOutcomeQuality,
  hasMeaningfulProfit,
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

function holdDecision(
  candidate: BestOutcomeEvaluation,
  live_quality: BestOutcomeQualityResult,
  reason: string
): LiveBestOutcomeDecision {
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

function closeDecision(
  candidate: BestOutcomeEvaluation,
  live_quality: BestOutcomeQualityResult,
  upl: number,
  reason: string
): LiveBestOutcomeDecision {
  return blockOptimizationCloseIfNotInProfit(
    {
      exit: true,
      action: 'CLOSE',
      reason,
      exit_kind: 'OPTIMIZATION',
      track: { ...candidate.track, state: 'EXIT', reason },
      view: {
        ...candidate.view,
        best_outcome_state: 'EXIT',
        best_outcome_reason: reason,
      },
      live_quality,
      live_overridden: true,
    },
    upl,
    candidate.track,
    candidate.view
  );
}

/**
 * Apply LIVE BO = R + α×D×C before exitTrade().
 *
 * HARD_SAFETY → CLOSE always
 * UPL ≤ 0 → HOLD (OPTIMIZATION)
 * Strong SAME (D=-1) → HOLD
 * Strong OPPOSITE (D=+1) + BO ok → CLOSE when in profit
 * Weak/neutral → candidate MFE/UPL logic only if UPL is meaningful (not +0.01 noise)
 */
export function decideLiveBestOutcomeExit(input: {
  candidate: BestOutcomeEvaluation;
  openSide: ExitSide;
  mfe: number;
  upl: number;
  entryPrice?: number | null;
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

  if (!canOptimizationClose(input.upl)) {
    return holdDecision(
      candidate,
      live_quality,
      input.upl < 0
        ? `HOLD · UPL ${input.upl.toFixed(5)} · Best Outcome never closes negative · SL/HARD SAFETY only · ${scoreLabel(live_quality)}`
        : `HOLD · UPL ${input.upl.toFixed(5)} · Best Outcome never closes at flat · SL/HARD SAFETY only · ${scoreLabel(live_quality)}`
    );
  }

  const d = live_quality.next_signal_direction;
  const c = live_quality.next_signal_confirm;
  const bo = live_quality.best_outcome_score;
  const strong = c != null && Number.isFinite(c) && c >= LIVE_CONFIRM_STRONG;
  const entryForMin =
    input.entryPrice != null && Number.isFinite(input.entryPrice) ? input.entryPrice : 2000;
  const meaningful = hasMeaningfulProfit(entryForMin, input.upl);

  // Strong SAME continuation → HOLD (do not exit early)
  if (strong && d === -1) {
    return holdDecision(
      candidate,
      live_quality,
      `LIVE HOLD · same-direction ${input.openSide} · ${scoreLabel(live_quality)} · formula blocks early EXIT`
    );
  }

  // Strong OPPOSITE → CLOSE in profit when BO supports (or candidate already wants exit)
  if (strong && d === 1) {
    const boOk = bo == null || bo >= LIVE_BO_CLOSE_MIN;
    if (boOk && (candidate.exit || meaningful)) {
      return closeDecision(
        candidate,
        live_quality,
        input.upl,
        `LIVE CLOSE · opposite confirmed · ${scoreLabel(live_quality)} · ${candidate.reason || 'formula'}`
      );
    }
    return holdDecision(
      candidate,
      live_quality,
      `LIVE HOLD · opposite weak BO/UPL · ${scoreLabel(live_quality)}`
    );
  }

  // Weak / neutral / D=0 → original MFE/UPL candidate, but not on tiny plus noise
  if (candidate.exit && candidate.exit_kind === 'OPTIMIZATION') {
    if (!meaningful) {
      return holdDecision(
        candidate,
        live_quality,
        `LIVE HOLD · UPL ${input.upl.toFixed(5)} below min meaningful · ${scoreLabel(live_quality)} · wait (${candidate.reason})`
      );
    }
    return blockOptimizationCloseIfNotInProfit(
      {
        ...candidate,
        reason: `LIVE CLOSE · weak/neutral confirm · MFE/UPL candidate · ${scoreLabel(live_quality)} · ${candidate.reason}`,
        live_quality,
        live_overridden: false,
      },
      input.upl,
      candidate.track,
      candidate.view
    );
  }

  return { ...candidate, live_quality, live_overridden: false };
}
