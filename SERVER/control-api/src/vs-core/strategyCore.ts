/**
 * Strategy Core — wraps proven strategy modules without rewriting algorithms.
 *
 * Strategy decides WHETHER there is a trade:
 *   ENTER_LONG / ENTER_SHORT → trade intent (BUY/SELL)
 *   NO_SETUP → no intent (not WAIT mode, not an error)
 *
 * Technical gates (feed/session/market closed/trading off) emit BLOCKED_TECHNICAL
 * so Risk/Safety remains the authority for safe execution — Strategy does not invent
 * artificial limits (cooldown, daily loss, max trades, etc.).
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
  | 'NO_SETUP'
  | 'BLOCKED_TECHNICAL';

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
  /** Precise technical reason when code=BLOCKED_TECHNICAL */
  block_reason?: string;
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
  late_move?: boolean;
  stale_quote_adverse?: boolean;
  spread_too_high?: boolean;
  /**
   * @deprecated Ignored. Artificial cooldown is not part of proven strategy.
   */
  in_cooldown?: boolean;
};

/**
 * Pure strategy evaluate — uses existing entryFromRegime / bias logic.
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
    block_reason: code === 'BLOCKED_TECHNICAL' ? reason : undefined,
  });

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

  // No closed bar yet → no setup (continue scanning) — not a WAIT trading mode.
  if (!input.bar_closed || !input.closed_bar) {
    return fail('NO_SETUP', 'No closed 10s bar yet');
  }
  if (input.late_move) {
    return fail('NO_SETUP', 'Late move on 1m candle — not a valid setup');
  }

  const bar = input.closed_bar;
  const eff = effectiveBias(regime, bias, bar);
  const entry = decideEntryFrom10sRegime(bar, regime, eff, input.bars);
  if (!entry) {
    const fadeRegimes = new Set([
      'RANGE',
      'FAILED_BREAKOUT_UP',
      'FAILED_BREAKOUT_DOWN',
      'REVERSAL_CANDIDATE',
    ]);
    if (fadeRegimes.has(regime)) {
      return fail('NO_SETUP', `${regime} — fade/reversal entry forbidden`, {
        effective_bias: eff,
        strategy_rule: 'NO_FADE',
      });
    }
    return fail('NO_SETUP', 'No with-trend setup on closed 10s', {
      effective_bias: eff,
    });
  }

  const deny = denyWithTrendEntry(entry.direction, bar, eff, input.bars);
  if (deny) {
    return fail('NO_SETUP', deny, {
      effective_bias: eff,
      attempted: entry.direction,
      strategy_rule: 'COUNTERTREND',
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
  if (d.code === 'BLOCKED_TECHNICAL') {
    return DecisionCodes.BLOCKED_TECHNICAL;
  }
  return DecisionCodes.NO_SETUP;
}
