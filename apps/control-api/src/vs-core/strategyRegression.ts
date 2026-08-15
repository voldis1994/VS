/**
 * Strategy regression baseline — frozen input → decision fingerprint.
 * Infrastructure refactors must not silently change algorithm behavior.
 */

import { createHash } from 'crypto';
import { evaluateStrategy, type StrategyDecision } from './strategyCore.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';
import { STRATEGY_VERSION, CONFIG_VERSION, FREEZE_COMMIT } from './versions.js';

export const REPLAY_BASELINE_ID = 'vs-strategy-replay-baseline-v1';
export const BASELINE_COMMIT = FREEZE_COMMIT;

export type BaselineCase = {
  id: string;
  input: Parameters<typeof evaluateStrategy>[0];
  /** Expected decision code — locked against silent algo drift. */
  expect_code: string;
  expect_direction: 'BUY' | 'SELL' | null;
};

function bar(o: number, h: number, l: number, c: number, t = 1_700_000_000_000): TenSecBar {
  return { open_time_ms: t, open: o, high: h, low: l, close: c, ticks: 4 };
}

/** Deterministic dataset — do not edit expected codes without marking STRATEGY BEHAVIOR CHANGE. */
export function strategyReplayBaselineCases(): BaselineCase[] {
  const climb = [
    bar(2400, 2401, 2399.5, 2400.5, 1),
    bar(2400.5, 2402, 2400.2, 2401.5, 2),
    bar(2401.5, 2403, 2401, 2402.8, 3),
  ];
  const dump = [
    bar(2402, 2402.2, 2400, 2400.5, 1),
    bar(2400.5, 2400.8, 2398, 2398.5, 2),
    bar(2398.5, 2398.8, 2396, 2396.5, 3),
  ];
  const flat = [
    bar(2400, 2400.1, 2399.9, 2400.05, 1),
    bar(2400.05, 2400.12, 2399.95, 2400.02, 2),
    bar(2400.02, 2400.08, 2399.98, 2400.01, 3),
  ];

  return [
    {
      id: 'market_closed',
      input: {
        epic: 'GOLD',
        market_snapshot_id: 'b1',
        market_open: false,
        feed_fresh: true,
        bar_closed: true,
        closed_bar: climb[2]!,
        bars: climb,
        regime: 'TREND_UP',
        trading_enabled: true,
      },
      expect_code: 'WAIT_MARKET_CLOSED',
      expect_direction: null,
    },
    {
      id: 'stale_feed',
      input: {
        epic: 'GOLD',
        market_snapshot_id: 'b2',
        market_open: true,
        feed_fresh: false,
        bar_closed: true,
        closed_bar: climb[2]!,
        bars: climb,
        regime: 'TREND_UP',
        trading_enabled: true,
      },
      expect_code: 'WAIT_STALE_FEED',
      expect_direction: null,
    },
    {
      id: 'bar_forming',
      input: {
        epic: 'GOLD',
        market_snapshot_id: 'b3',
        market_open: true,
        feed_fresh: true,
        bar_closed: false,
        closed_bar: null,
        bars: climb,
        regime: 'TREND_UP',
        trading_enabled: true,
      },
      expect_code: 'WAIT_BAR_FORMING',
      expect_direction: null,
    },
    {
      id: 'range_no_fade',
      input: {
        epic: 'GOLD',
        market_snapshot_id: 'b4',
        market_open: true,
        feed_fresh: true,
        bar_closed: true,
        closed_bar: flat[2]!,
        bars: flat,
        regime: 'RANGE',
        trading_enabled: true,
      },
      expect_code: 'WAIT_NO_FADE',
      expect_direction: null,
    },
    {
      id: 'trading_off',
      input: {
        epic: 'GOLD',
        market_snapshot_id: 'b5',
        market_open: true,
        feed_fresh: true,
        bar_closed: true,
        closed_bar: climb[2]!,
        bars: climb,
        regime: 'TREND_UP',
        trading_enabled: false,
      },
      expect_code: 'WAIT_TRADING_OFF',
      expect_direction: null,
    },
    {
      id: 'trend_up_pullback_or_follow',
      input: {
        epic: 'GOLD',
        market_snapshot_id: 'b6',
        market_open: true,
        feed_fresh: true,
        bar_closed: true,
        closed_bar: climb[2]!,
        bars: climb,
        regime: 'TREND_UP',
        trading_enabled: true,
        minute_candles: [
          { open: 2395, close: 2398 },
          { open: 2398, close: 2401 },
          { open: 2401, close: 2403 },
        ],
      },
      expect_code: 'ENTER_LONG',
      expect_direction: 'BUY',
    },
    {
      id: 'trend_down_follow',
      input: {
        epic: 'GOLD',
        market_snapshot_id: 'b7',
        market_open: true,
        feed_fresh: true,
        bar_closed: true,
        closed_bar: dump[2]!,
        bars: dump,
        regime: 'TREND_DOWN',
        trading_enabled: true,
        minute_candles: [
          { open: 2405, close: 2402 },
          { open: 2402, close: 2399 },
          { open: 2399, close: 2396 },
        ],
      },
      expect_code: 'ENTER_SHORT',
      expect_direction: 'SELL',
    },
  ];
}

export type RegressionResult = {
  baseline_id: string;
  baseline_commit: string;
  strategy_version: string;
  config_version: string;
  passed: number;
  failed: number;
  behavior_change: boolean;
  cases: Array<{
    id: string;
    ok: boolean;
    expected_code: string;
    actual_code: string;
    expected_direction: string | null;
    actual_direction: string | null;
  }>;
  fingerprint: string;
};

export function runStrategyRegression(): RegressionResult {
  const cases = strategyReplayBaselineCases();
  const out: RegressionResult['cases'] = [];
  let passed = 0;
  let failed = 0;

  for (const c of cases) {
    const d: StrategyDecision = evaluateStrategy(c.input);
    const ok = d.code === c.expect_code && d.direction === c.expect_direction;
    if (ok) passed += 1;
    else failed += 1;
    out.push({
      id: c.id,
      ok,
      expected_code: c.expect_code,
      actual_code: d.code,
      expected_direction: c.expect_direction,
      actual_direction: d.direction,
    });
  }

  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        baseline_id: REPLAY_BASELINE_ID,
        strategy_version: STRATEGY_VERSION,
        cases: out.map((x) => ({ id: x.id, code: x.actual_code, dir: x.actual_direction })),
      })
    )
    .digest('hex');

  return {
    baseline_id: REPLAY_BASELINE_ID,
    baseline_commit: BASELINE_COMMIT,
    strategy_version: STRATEGY_VERSION,
    config_version: CONFIG_VERSION,
    passed,
    failed,
    behavior_change: failed > 0,
    cases: out,
    fingerprint,
  };
}
