import { describe, expect, it } from 'vitest';
import {
  isHonestLivePaperClosed,
  shouldRetryLivePaperDemo,
  type LivePaperDemoReport,
} from '../livePaperHonesty.js';

function baseClosed(over: Partial<LivePaperDemoReport> = {}): LivePaperDemoReport {
  return {
    status: 'PASS_LIVE_DATA_CLOSED',
    forced_live_paper_fill: false,
    executed_cycles: 1,
    exit_phase: true,
    exit_cycles: 1,
    exit_reason: 'STOP_HIT',
    open_positions: 0,
    traded: 1,
    performance_trades: 1,
    performance_total_pnl: 1.25,
    ticks: [
      { mid: 4400, executed: true },
      { mid: 4390, executed: false, phase: 'exit_drive' },
    ],
    ...over,
  };
}

describe('isHonestLivePaperClosed', () => {
  it('accepts one natural fill + exit_drive', () => {
    expect(isHonestLivePaperClosed(baseClosed())).toBe(true);
  });

  it('rejects churn flood of identical-mid fills', () => {
    expect(
      isHonestLivePaperClosed(
        baseClosed({
          executed_cycles: 12,
          exit_phase: false,
          exit_cycles: 0,
          ticks: Array.from({ length: 12 }, () => ({
            mid: 4401.5,
            executed: true,
          })),
        })
      )
    ).toBe(false);
  });

  it('rejects CLOSED without tick-observed exit', () => {
    expect(
      isHonestLivePaperClosed(
        baseClosed({
          exit_phase: false,
          exit_cycles: 0,
          exit_reason: 'EMA13_CROSS_DOWN',
        })
      )
    ).toBe(false);
  });

  it('rejects forced fill', () => {
    expect(
      isHonestLivePaperClosed(baseClosed({ forced_live_paper_fill: true }))
    ).toBe(false);
  });

  it('rejects still-open book', () => {
    expect(isHonestLivePaperClosed(baseClosed({ open_positions: 1 }))).toBe(
      false
    );
  });

  it('rejects CLOSED without finite performance_total_pnl', () => {
    expect(
      isHonestLivePaperClosed(baseClosed({ performance_total_pnl: null }))
    ).toBe(false);
    expect(
      isHonestLivePaperClosed(baseClosed({ performance_total_pnl: undefined }))
    ).toBe(false);
  });

  it('accepts zero closed PnL when trades exist', () => {
    expect(
      isHonestLivePaperClosed(baseClosed({ performance_total_pnl: 0 }))
    ).toBe(true);
  });
});

describe('shouldRetryLivePaperDemo', () => {
  it('retries DECIDED/TRADED only', () => {
    expect(shouldRetryLivePaperDemo('PASS_LIVE_DATA_DECIDED')).toBe(true);
    expect(shouldRetryLivePaperDemo('PASS_LIVE_DATA_TRADED')).toBe(true);
    expect(shouldRetryLivePaperDemo('PASS_LIVE_DATA_CLOSED')).toBe(false);
    expect(shouldRetryLivePaperDemo('FAIL')).toBe(false);
    expect(shouldRetryLivePaperDemo(null)).toBe(false);
  });
});
