/**
 * Strategy Core — single production Strategy authority.
 *
 * REGIME DESCRIBES THE MARKET. REGIME DOES NOT GIVE PERMISSION TO TRADE.
 *
 * Strategy decides WHETHER there is a trade:
 *   ENTER_LONG / ENTER_SHORT → trade intent (BUY/SELL)
 *   NO_SETUP → no valid setup found (or setup invalidated — e.g. late move)
 *
 * Technical gates (feed/session/market closed/trading off) emit BLOCKED_TECHNICAL.
 */

import {
  decideEntryFrom10sRegime,
  denyWithTrendEntry,
  effectiveBias,
  resolveTrendBias,
  type RegimeEntry,
  type TrendBias,
} from '../services/entryFromRegime.js';
import { isLateMoveOnOneMinute } from '../services/capitalCom.js';
import { normalizeRegime, type RegimeName } from '../services/regimes.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';
import { DecisionCodes, type DecisionCode } from '../services/decisionCodes.js';
import { STRATEGY_VERSION, CONFIG_VERSION } from './versions.js';
import { newDecisionId } from './executionCore.js';
import { recordStrategyEvaluation } from './strategyEvalLog.js';

export type StrategyDecisionCode =
  | 'ENTER_LONG'
  | 'ENTER_SHORT'
  | 'NO_SETUP'
  | 'BLOCKED_TECHNICAL';

export type StrategyDecision = {
  decision_id: string;
  code: StrategyDecisionCode;
  direction: 'BUY' | 'SELL' | null;
  setup: RegimeEntry['setup'] | null;
  setup_type: RegimeEntry['setup'] | null;
  reason: string;
  strategy_version: string;
  config_version: string;
  market_snapshot_id: string;
  regime: RegimeName | string;
  bias: TrendBias;
  evidence: Record<string, unknown>;
  at: string;
  /** Precise technical reason when code=BLOCKED_TECHNICAL */
  block_reason?: string;
  /** Setup invalidated (e.g. LATE_MOVE_1M) — still NO_SETUP, not infrastructure failure */
  invalidation_reason?: string;
};

export type StrategyInput = {
  epic: string;
  market_snapshot_id: string;
  market_open: boolean;
  feed_fresh: boolean;
  bar_closed: boolean;
  closed_bar: TenSecBar | null;
  bars: TenSecBar[];
  regime: RegimeName | string;
  minute_candles?: Array<{ open: number; close: number; high?: number; low?: number }>;
  trading_enabled: boolean;
  manage_only?: boolean;
  /**
   * @deprecated Prefer minute_candles — Strategy owns late-move as SETUP_INVALIDATED.
   * If true without candles, treated as setup invalidation (NO_SETUP), not BLOCKED_TECHNICAL.
   */
  late_move?: boolean;
  stale_quote_adverse?: boolean;
  spread_too_high?: boolean;
  /**
   * @deprecated Ignored. Artificial cooldown is not part of proven strategy.
   */
  in_cooldown?: boolean;
  reference_price?: number | null;
};

/**
 * Pure strategy evaluate — uses entryFromRegime / bias as CONTEXT.
 * Does NOT call broker. Does NOT apply artificial trading limits.
 */
export function evaluateStrategy(input: StrategyInput): StrategyDecision {
  const at = new Date().toISOString();
  const base = {
    decision_id: newDecisionId(),
    strategy_version: STRATEGY_VERSION,
    config_version: CONFIG_VERSION,
    market_snapshot_id: input.market_snapshot_id,
    at,
    evidence: {
      epic: input.epic,
      regime: input.regime,
      bar_closed: input.bar_closed,
    },
  };

  void input.in_cooldown; // artificial — never blocks

  const bias = resolveTrendBias(input.bars, input.minute_candles);
  const regime = normalizeRegime(input.regime);
  const refPx =
    input.reference_price ??
    input.closed_bar?.close ??
    (input.bars.length ? input.bars[input.bars.length - 1]!.close : null);

  const fail = (
    code: StrategyDecisionCode,
    reason: string,
    extra?: Record<string, unknown> & { invalidation_reason?: string }
  ): StrategyDecision => {
    const { invalidation_reason, ...ev } = extra || {};
    const d: StrategyDecision = {
      ...base,
      code,
      direction: null,
      setup: null,
      setup_type: null,
      reason,
      regime,
      bias,
      evidence: { ...base.evidence, ...ev, reference_price: refPx },
      block_reason: code === 'BLOCKED_TECHNICAL' ? reason : undefined,
      invalidation_reason,
    };
    recordStrategyEvaluation({
      timestamp: at,
      market: input.epic,
      regime,
      bias,
      setup_candidate: (ev.setup_candidate as string) || null,
      evidence: d.evidence,
      decision: code,
      reason,
      reference_price: refPx,
      invalidation_reason: invalidation_reason || null,
    });
    return d;
  };

  if (!input.trading_enabled) {
    return fail('BLOCKED_TECHNICAL', 'Trading disabled for client');
  }
  if (input.manage_only) {
    return fail('BLOCKED_TECHNICAL', 'Manage-only mode');
  }
  if (!input.market_open) {
    return fail('BLOCKED_TECHNICAL', 'Market closed');
  }
  if (!input.feed_fresh || input.stale_quote_adverse) {
    return fail('BLOCKED_TECHNICAL', 'PRIMARY feed stale');
  }
  if (input.spread_too_high) {
    return fail('BLOCKED_TECHNICAL', 'Spread exceeds broker/account max');
  }

  if (!input.bar_closed || !input.closed_bar) {
    return fail('NO_SETUP', 'No closed 10s bar yet');
  }

  const bar = input.closed_bar;
  const eff = effectiveBias(regime, bias, bar);
  const entry = decideEntryFrom10sRegime(bar, regime, eff, input.bars);

  if (!entry) {
    return fail('NO_SETUP', 'No valid setup found for current market evidence', {
      effective_bias: eff,
      setup_candidate: null,
      strategy_rule: 'NO_EVIDENCE',
    });
  }

  // Propagate FADE / countertrend-allowed context into with-trend veto
  const deny = denyWithTrendEntry(entry.direction, bar, eff, input.bars, {
    exhaustion: Boolean(entry.exhaustion),
    allowCountertrend: Boolean(entry.allow_countertrend || entry.exhaustion),
  });
  if (deny) {
    return fail('NO_SETUP', deny, {
      effective_bias: eff,
      attempted: entry.direction,
      setup_candidate: entry.setup,
      strategy_rule: 'SETUP_DENIED',
    });
  }

  // Late move = setup invalidated (opportunity gone) — NOT infrastructure failure.
  // Strategy is the single owner; desk must not re-apply a second market-analysis gate.
  if (input.late_move) {
    return fail(
      'NO_SETUP',
      'SETUP_INVALIDATED · late move — entry opportunity no longer valid',
      {
        invalidation_reason: 'LATE_MOVE',
        setup_candidate: entry.setup,
        effective_bias: eff,
      }
    );
  }
  if (input.minute_candles && input.minute_candles.length > 0) {
    if (isLateMoveOnOneMinute(entry.direction, input.minute_candles as never)) {
      return fail(
        'NO_SETUP',
        'SETUP_INVALIDATED · late on 1m candle — entry opportunity no longer valid',
        {
          invalidation_reason: 'LATE_MOVE_1M',
          setup_candidate: entry.setup,
          effective_bias: eff,
          attempted: entry.direction,
        }
      );
    }
  }

  const decision: StrategyDecision = {
    ...base,
    code: entry.direction === 'BUY' ? 'ENTER_LONG' : 'ENTER_SHORT',
    direction: entry.direction,
    setup: entry.setup,
    setup_type: entry.setup,
    reason: entry.reason,
    regime,
    bias: eff,
    evidence: {
      ...base.evidence,
      setup: entry.setup,
      setup_type: entry.setup,
      setup_candidate: entry.setup,
      effective_bias: eff,
      exhaustion: Boolean(entry.exhaustion),
      allow_countertrend: Boolean(entry.allow_countertrend),
      reference_price: refPx,
      closed_bar: {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      },
    },
  };
  recordStrategyEvaluation({
    timestamp: at,
    market: input.epic,
    regime,
    bias: eff,
    setup_candidate: entry.setup,
    evidence: decision.evidence,
    decision: decision.code,
    reason: decision.reason,
    reference_price: refPx,
    invalidation_reason: null,
  });
  return decision;
}

/** Map strategy decision to DecisionCode for ticks/UI. */
export function strategyToDecisionCode(d: StrategyDecision): DecisionCode {
  if (d.code === 'ENTER_LONG' || d.code === 'ENTER_SHORT') {
    return DecisionCodes.SIGNAL_CREATED;
  }
  if (d.code === 'BLOCKED_TECHNICAL') {
    return DecisionCodes.BLOCKED_TECHNICAL;
  }
  return DecisionCodes.NO_SETUP;
}
