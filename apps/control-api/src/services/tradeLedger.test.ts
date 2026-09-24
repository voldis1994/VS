import { describe, expect, it } from 'vitest';
import {
  bucketFromRows,
  computeExpectancy,
  computePnlPts,
  parseExpectancyWindow,
  summarizeExitReason,
} from './tradeLedger.js';

describe('tradeLedger expectancy', () => {
  it('computePnlPts BUY/SELL', () => {
    expect(computePnlPts('BUY', 2000, 2002)).toBeCloseTo(2);
    expect(computePnlPts('SELL', 2000, 1997)).toBeCloseTo(3);
  });

  it('summarizeExitReason buckets Soft/Peak/Target', () => {
    expect(summarizeExitReason('HardInvalidation · UPL -2')).toBe('HardInvalidation');
    expect(summarizeExitReason('PeakProtection · retention 65%')).toBe('PeakProtection');
    expect(summarizeExitReason('Target / best outcome')).toBe('Target');
    expect(summarizeExitReason('broker flat on epic')).toBe('External');
  });

  it('positive R:R sample → positive expectancy', () => {
    const rows = [
      { pnl_pts: 3, pnl: null, regime: 'TREND_UP', setup_type: 'PULLBACK', exit_reason: 'PeakProtection', epic: 'GOLD', mfe: 4, mae: -0.5, hold_ms: 60_000 },
      { pnl_pts: 3, pnl: null, regime: 'TREND_UP', setup_type: 'PULLBACK', exit_reason: 'PeakProtection', epic: 'GOLD', mfe: 4, mae: -0.4, hold_ms: 50_000 },
      { pnl_pts: 5, pnl: null, regime: 'TREND_UP', setup_type: 'PULLBACK', exit_reason: 'Target', epic: 'GOLD', mfe: 5, mae: -0.2, hold_ms: 120_000 },
      { pnl_pts: 4, pnl: null, regime: 'RANGE', setup_type: 'FADE', exit_reason: 'PeakProtection', epic: 'GOLD', mfe: 4.5, mae: -0.3, hold_ms: 40_000 },
      { pnl_pts: -2.2, pnl: null, regime: 'RANGE', setup_type: 'FADE', exit_reason: 'HardInvalidation', epic: 'GOLD', mfe: 0.5, mae: -2.2, hold_ms: 20_000 },
    ];
    const report = computeExpectancy(rows, { window: '7d' });
    expect(report.sample_size).toBe(5);
    expect(report.total.expectancy_pts).toBeGreaterThan(0);
    expect(report.total.wins).toBe(4);
    expect(report.total.losses).toBe(1);
    expect(report.by_regime.find((b) => b.key === 'TREND_UP')?.trades).toBe(3);
    expect(report.by_setup.find((b) => b.key === 'PULLBACK')?.expectancy_pts).toBeGreaterThan(0);
  });

  it('80% tiny wins vs large loss → negative expectancy (asymmetry proof)', () => {
    const rows = [
      ...Array.from({ length: 8 }, () => ({
        pnl_pts: 0.8,
        pnl: null,
        regime: 'RANGE',
        setup_type: 'FADE',
        exit_reason: 'PeakProtection',
        epic: 'GOLD',
        mfe: 1,
        mae: -0.2,
        hold_ms: 10_000,
      })),
      {
        pnl_pts: -5,
        pnl: null,
        regime: 'RANGE',
        setup_type: 'FADE',
        exit_reason: 'HardInvalidation',
        epic: 'GOLD',
        mfe: 0.5,
        mae: -5,
        hold_ms: 25_000,
      },
      {
        pnl_pts: -5,
        pnl: null,
        regime: 'RANGE',
        setup_type: 'FADE',
        exit_reason: 'HardInvalidation',
        epic: 'GOLD',
        mfe: 0.3,
        mae: -5,
        hold_ms: 30_000,
      },
    ];
    const b = bucketFromRows('RANGE', rows);
    expect(b.win_rate).toBeGreaterThan(0.7);
    expect(b.expectancy_pts).toBeLessThan(0);
  });

  it('parseExpectancyWindow defaults to 30d', () => {
    expect(parseExpectancyWindow(undefined).window).toBe('30d');
    expect(parseExpectancyWindow('all').since).toBeNull();
    expect(parseExpectancyWindow('7d').window).toBe('7d');
  });
});
