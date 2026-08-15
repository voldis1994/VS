/**
 * Strategy Core — wraps proven strategy modules without rewriting algorithms.
 * Output is always a structured Decision (never UNKNOWN).
 */

import {
  decideEntryFrom10sRegime,
  denyWithTrendEntry,
  effectiveBias,
  resolveTrendBias,
  type RegimeEntry,
  type TrendBias,
} from '../services/entryFromRegime.js';
import { normalizeRegime, type RegimeName } from '../services/regimes.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';
import { DecisionCodes, type DecisionCode } from '../services/decisionCodes.js';
import { STRATEGY_VERSION, CONFIG_VERSION } from './versions.js';
import { newDecisionId } from './executionCore.js';

export type StrategyDecisionCode =
  | 'ENTER_LONG'
  | 'ENTER_SHORT'
  | typeof DecisionCodes.WAIT_NO_SETUP
  | typeof DecisionCodes.WAIT_MARKET_CLOSED
  | typeof DecisionCodes.WAIT_SPREAD_TOO_HIGH
  | typeof DecisionCodes.WAIT_STALE_FEED
  | typeof DecisionCodes.WAIT_RISK_LIMIT
  | typeof DecisionCodes.WAIT_COUNTERTREND
  | typeof DecisionCodes.WAIT_NO_FADE
  | typeof DecisionCodes.WAIT_BAR_FORMING
  | typeof DecisionCodes.WAIT_COOLDOWN
  | typeof DecisionCodes.WAIT_LATE_MOVE
  | typeof DecisionCodes.WAIT_TRADING_OFF
  | typeof DecisionCodes.WAIT_MANAGE_ONLY
  | typeof DecisionCodes.ERROR_STATE_UNRESOLVED;

export type StrategyDecision = {
  decision_id: string;
  code: StrategyDecisionCode;
  direction: 'BUY' | 'SELL' | null;
  setup: RegimeEntry['setup'] | null;
  reason: string;
  strategy_version: string;
  config_version: string;
  market_snapshot_id: string;
  regime: RegimeName | string;
  bias: TrendBias;
  evidence: Record<string, unknown>;
  at: string;
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
  minute_candles?: Array<{ open: number; close: number }>;
  trading_enabled: boolean;
  manage_only?: boolean;
  in_cooldown?: boolean;
  late_move?: boolean;
  stale_quote_adverse?: boolean;
  spread_too_high?: boolean;
};

/**
 * Pure strategy evaluate — uses existing entryFromRegime / bias logic.
 * Does NOT call broker. Does NOT self-authorize risk.
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

  const bias = resolveTrendBias(input.bars, input.minute_candles);
  const regime = normalizeRegime(input.regime);

  const fail = (
    code: StrategyDecisionCode,
    reason: string,
    extra?: Record<string, unknown>
  ): StrategyDecision => ({
    ...base,
    code,
    direction: null,
    setup: null,
    reason,
    regime,
    bias,
    evidence: { ...base.evidence, ...extra },
  });

  if (!input.trading_enabled) {
    return fail(DecisionCodes.WAIT_TRADING_OFF, 'Trading disabled for client');
  }
  if (input.manage_only) {
    return fail(DecisionCodes.WAIT_MANAGE_ONLY, 'Manage-only mode');
  }
  if (!input.market_open) {
    return fail(DecisionCodes.WAIT_MARKET_CLOSED, 'Market closed');
  }
  if (!input.feed_fresh) {
    return fail(DecisionCodes.WAIT_STALE_FEED, 'Feed stale');
  }
  if (input.spread_too_high) {
    return fail(DecisionCodes.WAIT_SPREAD_TOO_HIGH, 'Spread too high');
  }
  if (input.in_cooldown) {
    return fail(DecisionCodes.WAIT_COOLDOWN, 'Cooldown');
  }
  if (!input.bar_closed || !input.closed_bar) {
    return fail(DecisionCodes.WAIT_BAR_FORMING, 'Waiting for 10s bar close');
  }
  if (input.stale_quote_adverse) {
    return fail(DecisionCodes.WAIT_STALE_FEED, 'Stale Capital vs fresher refs');
  }
  if (input.late_move) {
    return fail(DecisionCodes.WAIT_LATE_MOVE, 'Late move on 1m candle');
  }

  const bar = input.closed_bar;
  const eff = effectiveBias(regime, bias, bar);
  // Existing signature: (bar, regime?, bias, recent?)
  const entry = decideEntryFrom10sRegime(bar, regime, eff, input.bars);
  if (!entry) {
    const fadeRegimes = new Set([
      'RANGE',
      'FAILED_BREAKOUT_UP',
      'FAILED_BREAKOUT_DOWN',
      'REVERSAL_CANDIDATE',
    ]);
    if (fadeRegimes.has(regime)) {
      return fail(DecisionCodes.WAIT_NO_FADE, `${regime} — fade/reversal entry forbidden`, {
        effective_bias: eff,
      });
    }
    return fail(DecisionCodes.WAIT_NO_SETUP, 'No with-trend setup on closed 10s', {
      effective_bias: eff,
    });
  }

  const deny = denyWithTrendEntry(entry.direction, bar, eff, input.bars);
  if (deny) {
    return fail(DecisionCodes.WAIT_COUNTERTREND, deny, {
      effective_bias: eff,
      attempted: entry.direction,
    });
  }

  return {
    ...base,
    code: entry.direction === 'BUY' ? 'ENTER_LONG' : 'ENTER_SHORT',
    direction: entry.direction,
    setup: entry.setup,
    reason: entry.reason,
    regime,
    bias: eff,
    evidence: {
      ...base.evidence,
      setup: entry.setup,
      effective_bias: eff,
      closed_bar: {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      },
    },
  };
}

/** Map strategy decision to DecisionCode for ticks/UI. */
export function strategyToDecisionCode(d: StrategyDecision): DecisionCode {
  if (d.code === 'ENTER_LONG' || d.code === 'ENTER_SHORT') {
    return DecisionCodes.SIGNAL_CREATED;
  }
  return d.code as DecisionCode;
}
