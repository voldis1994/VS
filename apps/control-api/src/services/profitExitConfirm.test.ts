import { describe, expect, it, vi } from 'vitest';
import {
  applyProfitExitConfirmClose,
  capitalClosed1mKey,
  closed1mOppositeToSide,
  isImmediateManageExitReason,
  isProfitManageExitReason,
  resolveProfitExitConfirm,
  type Closed1mSnap,
  type ProfitExitConfirmState,
} from './profitExitConfirm.js';

function snap(partial: {
  open: number;
  close: number;
  key?: string;
  snapshot_time_ms?: number;
}): Closed1mSnap {
  return {
    open: partial.open,
    close: partial.close,
    key:
      partial.key ??
      capitalClosed1mKey({
        open: partial.open,
        close: partial.close,
        snapshot_time_ms: partial.snapshot_time_ms ?? null,
      }),
  };
}

describe('profitExitConfirm — classify', () => {
  it('treats Peak/Target/TimeDecay/Mind as profit', () => {
    expect(isProfitManageExitReason('PeakProtection · retention 60%')).toBe(true);
    expect(isProfitManageExitReason('Target / best outcome · RANGE')).toBe(true);
    expect(isProfitManageExitReason('TimeDecay · held 120s')).toBe(true);
    expect(isProfitManageExitReason('MindBank · Soft+ giveback')).toBe(true);
    expect(isProfitManageExitReason('MindCut · story fade')).toBe(true);
  });

  it('HardInv / structure / safety close immediately (not profit filter)', () => {
    expect(isImmediateManageExitReason('HardInvalidation · UPL -2.2')).toBe(true);
    expect(isImmediateManageExitReason('StructureInvalidation · back under')).toBe(true);
    expect(isProfitManageExitReason('HardInvalidation · UPL -2.2')).toBe(false);
    expect(isProfitManageExitReason('StructureInvalidation · thesis')).toBe(false);
  });

  it('BUY opposite = red 1m; SELL opposite = green 1m', () => {
    expect(closed1mOppositeToSide('BUY', { open: 100, close: 99 })).toBe(true);
    expect(closed1mOppositeToSide('BUY', { open: 100, close: 101 })).toBe(false);
    expect(closed1mOppositeToSide('SELL', { open: 100, close: 101 })).toBe(true);
    expect(closed1mOppositeToSide('SELL', { open: 100, close: 99 })).toBe(false);
  });
});

describe('profitExitConfirm — wait next opposite closed 1m', () => {
  it('arms on PROFIT and does not exit on the same closed 1m', () => {
    const c0 = snap({ open: 2650, close: 2652, snapshot_time_ms: 1_000 });
    const d = resolveProfitExitConfirm({
      exitReason: 'PeakProtection · retention 70%',
      openSide: 'BUY',
      pending: null,
      lastClosed1m: c0,
    });
    expect(d.action).toBe('arm_and_wait');
    if (d.action !== 'arm_and_wait') return;
    expect(d.state.armed_at_1m_key).toBe('1000');
    expect(d.state.reason).toMatch(/PeakProtection/);
  });

  it('keeps waiting until a newer closed 1m appears', () => {
    const pending: ProfitExitConfirmState = {
      reason: 'Target / best outcome',
      armed_at_1m_key: '1000',
    };
    const same = snap({ open: 2650, close: 2652, snapshot_time_ms: 1_000 });
    const d = resolveProfitExitConfirm({
      exitReason: 'Target / best outcome',
      openSide: 'BUY',
      pending,
      lastClosed1m: same,
    });
    expect(d.action).toBe('keep_waiting');
  });

  it('BUY: closes only after next closed 1m with close < open', () => {
    const pending: ProfitExitConfirmState = {
      reason: 'PeakProtection · bank',
      armed_at_1m_key: '1000',
    };
    const opposite = snap({ open: 2655, close: 2651, snapshot_time_ms: 2_000 });
    const d = resolveProfitExitConfirm({
      exitReason: null,
      openSide: 'BUY',
      pending,
      lastClosed1m: opposite,
    });
    expect(d.action).toBe('exit_profit');
    if (d.action === 'exit_profit') {
      expect(d.reason).toMatch(/PeakProtection/);
      expect(d.reason).toMatch(/1m confirm BUY opposite/);
    }
  });

  it('SELL: closes only after next closed 1m with close > open', () => {
    const pending: ProfitExitConfirmState = {
      reason: 'MindBank · trail',
      armed_at_1m_key: '1000',
    };
    const opposite = snap({ open: 2650, close: 2654, snapshot_time_ms: 2_000 });
    const d = resolveProfitExitConfirm({
      exitReason: 'MindBank · trail',
      openSide: 'SELL',
      pending,
      lastClosed1m: opposite,
    });
    expect(d.action).toBe('exit_profit');
  });

  it('next 1m not opposite → continue MANAGE (no exit)', () => {
    const pending: ProfitExitConfirmState = {
      reason: 'TimeDecay · lock',
      armed_at_1m_key: '1000',
    };
    // BUY still green — not opposite
    const sameDir = snap({ open: 2650, close: 2653, snapshot_time_ms: 2_000 });
    const d = resolveProfitExitConfirm({
      exitReason: null,
      openSide: 'BUY',
      pending,
      lastClosed1m: sameDir,
    });
    expect(d.action).toBe('reject_continue_manage');
  });

  it('HardInv exits immediately even with pending profit confirm', () => {
    const pending: ProfitExitConfirmState = {
      reason: 'PeakProtection · armed',
      armed_at_1m_key: '1000',
    };
    const d = resolveProfitExitConfirm({
      exitReason: 'HardInvalidation · UPL -2.2 (SL 2.2)',
      openSide: 'BUY',
      pending,
      lastClosed1m: snap({ open: 100, close: 99, snapshot_time_ms: 2_000 }),
    });
    expect(d.action).toBe('exit_immediate');
    if (d.action === 'exit_immediate') {
      expect(d.reason).toMatch(/HardInvalidation/);
    }
  });
});

describe('profitExitConfirm — closeCapitalPosition only after opposite 1m', () => {
  it('does not call closeCapitalPosition on first PROFIT signal', async () => {
    const closeCapitalPosition = vi.fn(async (_reason: string) => {});
    const c0 = snap({ open: 100, close: 101, snapshot_time_ms: 10 });

    const r1 = await applyProfitExitConfirmClose({
      exitReason: 'PeakProtection · retention 65%',
      openSide: 'SELL',
      pending: null,
      lastClosed1m: c0,
      closeCapitalPosition,
    });
    expect(r1.closed).toBe(false);
    expect(closeCapitalPosition).not.toHaveBeenCalled();
    expect(r1.pending?.armed_at_1m_key).toBe('10');

    // Same closed 1m still forming next — still no close
    const r2 = await applyProfitExitConfirmClose({
      exitReason: 'PeakProtection · retention 65%',
      openSide: 'SELL',
      pending: r1.pending,
      lastClosed1m: c0,
      closeCapitalPosition,
    });
    expect(r2.closed).toBe(false);
    expect(closeCapitalPosition).not.toHaveBeenCalled();
  });

  it('calls closeCapitalPosition only after next opposite closed 1m (SELL)', async () => {
    const closeCapitalPosition = vi.fn(async (_reason: string) => {});
    const armed = snap({ open: 100, close: 99, snapshot_time_ms: 10 }); // SELL continue

    const r1 = await applyProfitExitConfirmClose({
      exitReason: 'Target / best outcome · RANGE',
      openSide: 'SELL',
      pending: null,
      lastClosed1m: armed,
      closeCapitalPosition,
    });
    expect(closeCapitalPosition).not.toHaveBeenCalled();

    // Next 1m still with SELL (red) — not opposite → no close
    const sameThesis = snap({ open: 99, close: 98, snapshot_time_ms: 20 });
    const r2 = await applyProfitExitConfirmClose({
      exitReason: 'Target / best outcome · RANGE',
      openSide: 'SELL',
      pending: r1.pending,
      lastClosed1m: sameThesis,
      closeCapitalPosition,
    });
    expect(closeCapitalPosition).not.toHaveBeenCalled();
    // re-armed on non-opposite when profit still signaled
    expect(r2.pending?.armed_at_1m_key).toBe('20');

    // Next 1m green (close > open) — opposite for SELL → close
    const opposite = snap({ open: 98, close: 99.5, snapshot_time_ms: 30 });
    const r3 = await applyProfitExitConfirmClose({
      exitReason: 'Target / best outcome · RANGE',
      openSide: 'SELL',
      pending: r2.pending,
      lastClosed1m: opposite,
      closeCapitalPosition,
    });
    expect(r3.closed).toBe(true);
    expect(closeCapitalPosition).toHaveBeenCalledTimes(1);
    expect(closeCapitalPosition.mock.calls[0]![0]).toMatch(/Target/);
    expect(closeCapitalPosition.mock.calls[0]![0]).toMatch(/1m confirm SELL opposite/);
  });

  it('calls closeCapitalPosition only after next opposite closed 1m (BUY)', async () => {
    const closeCapitalPosition = vi.fn(async (_reason: string) => {});
    const armed = snap({ open: 200, close: 201, snapshot_time_ms: 100 });

    const r1 = await applyProfitExitConfirmClose({
      exitReason: 'MindBank · Soft+ giveback',
      openSide: 'BUY',
      pending: null,
      lastClosed1m: armed,
      closeCapitalPosition,
    });
    expect(closeCapitalPosition).not.toHaveBeenCalled();

    const opposite = snap({ open: 201, close: 199.5, snapshot_time_ms: 200 });
    const r2 = await applyProfitExitConfirmClose({
      exitReason: null,
      openSide: 'BUY',
      pending: r1.pending,
      lastClosed1m: opposite,
      closeCapitalPosition,
    });
    expect(r2.closed).toBe(true);
    expect(closeCapitalPosition).toHaveBeenCalledTimes(1);
    expect(closeCapitalPosition.mock.calls[0]![0]).toMatch(/MindBank/);
  });

  it('HardInv calls closeCapitalPosition immediately without waiting 1m', async () => {
    const closeCapitalPosition = vi.fn(async (_reason: string) => {});
    const r = await applyProfitExitConfirmClose({
      exitReason: 'HardInvalidation · Soft',
      openSide: 'BUY',
      pending: {
        reason: 'PeakProtection · waiting',
        armed_at_1m_key: '1',
      },
      lastClosed1m: snap({ open: 1, close: 1, snapshot_time_ms: 1 }),
      closeCapitalPosition,
    });
    expect(r.closed).toBe(true);
    expect(closeCapitalPosition).toHaveBeenCalledTimes(1);
    expect(closeCapitalPosition.mock.calls[0]![0]).toMatch(/HardInvalidation/);
  });
});
