/**
 * Replay Engine — historical market → strategy → decision.
 * REPLAY must never submit broker orders (enforced via Risk + mode flag).
 */

import { evaluateStrategy, type StrategyDecision, type StrategyInput } from './strategyCore.js';
import { evaluateRisk, type RiskContext } from './riskCore.js';

export type ReplayTick = {
  epic: string;
  bid: number;
  ask: number;
  source_timestamp: string;
  market_status?: string;
  /** Optional precomputed strategy input overrides per tick. */
  strategy?: Partial<StrategyInput> & Pick<StrategyInput, 'closed_bar' | 'bars' | 'regime' | 'bar_closed'>;
};

export type ReplayResult = {
  mode: 'REPLAY';
  decisions: StrategyDecision[];
  broker_orders_attempted: number;
  blocked_by_risk: number;
};

/**
 * Run saved market period through strategy without broker orders.
 */
export function runReplay(
  ticks: ReplayTick[],
  baseStrategy: Omit<StrategyInput, 'closed_bar' | 'bars' | 'regime' | 'bar_closed' | 'market_snapshot_id'> & {
    market_snapshot_id?: string;
  }
): ReplayResult {
  const decisions: StrategyDecision[] = [];
  let blocked = 0;

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    if (!t.strategy) continue;
    const input: StrategyInput = {
      ...baseStrategy,
      epic: t.epic,
      market_snapshot_id: baseStrategy.market_snapshot_id || `replay_${i}`,
      market_open: baseStrategy.market_open ?? true,
      feed_fresh: baseStrategy.feed_fresh ?? true,
      trading_enabled: baseStrategy.trading_enabled ?? true,
      closed_bar: t.strategy.closed_bar,
      bars: t.strategy.bars,
      regime: t.strategy.regime,
      bar_closed: t.strategy.bar_closed,
      minute_candles: t.strategy.minute_candles ?? baseStrategy.minute_candles,
      manage_only: t.strategy.manage_only ?? baseStrategy.manage_only,
      in_cooldown: t.strategy.in_cooldown ?? baseStrategy.in_cooldown,
      late_move: t.strategy.late_move ?? baseStrategy.late_move,
      stale_quote_adverse:
        t.strategy.stale_quote_adverse ?? baseStrategy.stale_quote_adverse,
      spread_too_high: t.strategy.spread_too_high ?? baseStrategy.spread_too_high,
    };
    const d = evaluateStrategy(input);
    decisions.push(d);

    if (d.code === 'ENTER_LONG' || d.code === 'ENTER_SHORT') {
      const riskCtx: RiskContext = {
        client_id: 0,
        account_id: 0,
        epic: t.epic,
        direction: d.direction!,
        size: 1,
        client_trading_enabled: true,
        market_open: true,
        feed_fresh: true,
        feed_offline: false,
        spread: t.ask - t.bid,
        max_spread: null,
        has_open_position: false,
        has_duplicate_intent: false,
        in_cooldown: false,
        session_healthy: true,
        time_sync_ok: true,
        reconcile_clean: true,
        stop_attached: true,
        operating_mode: 'REPLAY',
        live_trading_enabled: false,
      };
      const risk = evaluateRisk(riskCtx);
      if (!risk.ok) blocked += 1;
    }
  }

  return {
    mode: 'REPLAY',
    decisions,
    broker_orders_attempted: 0,
    blocked_by_risk: blocked,
  };
}
