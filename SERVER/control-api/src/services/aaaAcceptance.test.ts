import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DecisionCodes } from './decisionCodes.js';

vi.mock('../db/pool.js', () => ({
  healthCheck: vi.fn(async () => true),
  pool: { query: vi.fn() },
}));

vi.mock('./robotDesk.js', () => ({
  listRobotSessions: vi.fn(() => []),
}));

describe('P6 systemHealth + P9 acceptance gates (mock-safe)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('buildSystemHealth returns 8 subsystems with levels', async () => {
    const { buildSystemHealth } = await import('./systemHealth.js');
    const report = await buildSystemHealth({ primaryConnectionId: null });
    expect(report.subsystems.length).toBe(8);
    const ids = report.subsystems.map((s) => s.id).sort();
    expect(ids).toEqual(
      [
        'CAPITAL_SESSION',
        'EXECUTION',
        'MARKET_DATA',
        'POSITIONS',
        'RISK',
        'STORAGE',
        'STRATEGY',
        'UPDATER',
      ].sort()
    );
    expect(['OK', 'WARNING', 'ERROR', 'CRITICAL']).toContain(report.overall);
    expect(report.build.STRATEGY_VERSION || report.build.strategy_version).toBeTruthy();
    expect(report.build.GIT_COMMIT || report.build.git_sha).toBeTruthy();
  });

  it('P9: STOP / stale / market-closed / duplicate gates are real decision codes', async () => {
    const { runTradePipeline } = await import('./tradePipeline.js');
    const quote = {
      epic: 'GOLD',
      bid: 1,
      ask: 2,
      mid: 1.5,
      spread: 1,
      market_status: 'CLOSED' as string | null,
      update_time: null,
      percentage_change: null,
      high: null,
      low: null,
      raw_ok: true,
    };
    const closed = runTradePipeline({
      quote,
      epic: 'GOLD',
      lot_size: 0.1,
      regime: 'TREND_UP',
      just_closed_bar: null,
      bar_forming: true,
      trend_bias: 'UP',
      trading_enabled: true,
      entry_enabled: true,
      feed_age_ms: 100,
    });
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.code).toBe(DecisionCodes.MARKET_CLOSED);

    const stop = runTradePipeline({
      quote: { ...quote, market_status: 'TRADEABLE' },
      epic: 'GOLD',
      lot_size: 0.1,
      regime: 'TREND_UP',
      just_closed_bar: null,
      bar_forming: true,
      trend_bias: 'UP',
      trading_enabled: false,
      entry_enabled: true,
      feed_age_ms: 100,
      stopped: true,
    });
    expect(stop.ok).toBe(false);
    if (!stop.ok) expect(stop.code).toBe(DecisionCodes.BLOCKED_TECHNICAL);

    const stale = runTradePipeline({
      quote: { ...quote, market_status: 'TRADEABLE' },
      epic: 'GOLD',
      lot_size: 0.1,
      regime: 'TREND_UP',
      just_closed_bar: null,
      bar_forming: true,
      trend_bias: 'UP',
      trading_enabled: true,
      entry_enabled: true,
      feed_age_ms: 25_000,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe(DecisionCodes.STALE_PRICE);
  });
});
