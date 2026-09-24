import { _setTradeOpenAtStartForTests } from './tradeOpenPolicy.js';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { sameDirNextMoveConfirms } from './sameDirNextMove.js';
import * as softGate from './softExitMarketGate.js';

describe('sameDirNextMoveConfirms', () => {
  beforeEach(() => {
    _setTradeOpenAtStartForTests(false);
  });
  afterEach(() => {
    _setTradeOpenAtStartForTests(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows same-dir when closed 1m continues with side', () => {
    const ok = sameDirNextMoveConfirms({
      side: 'SELL',
      closed1m: { open: 4340, close: 4338 },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.tag).toMatch(/1m continue SELL/);
  });

  it('blocks same-dir when 1m reversed', () => {
    const no = sameDirNextMoveConfirms({
      side: 'SELL',
      closed1m: { open: 4338, close: 4341 },
    });
    expect(no.ok).toBe(false);
    if (!no.ok) expect(no.reason).toMatch(/1m reverse/);
  });

  it('allows same-dir when next entry peek matches side', () => {
    vi.spyOn(softGate, 'peekNextEntrySide').mockReturnValue({
      side: 'SELL',
      setup: 'PULLBACK',
      reason: 'TREND_DOWN',
    });
    const ok = sameDirNextMoveConfirms({
      side: 'SELL',
      closed1m: { open: 4340, close: 4340 }, // wait/flat
      closedBars: [],
      regime: 'TREND_DOWN',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.tag).toMatch(/next entry SELL/);
  });

  it('blocks same-dir when next entry flipped opposite', () => {
    vi.spyOn(softGate, 'peekNextEntrySide').mockReturnValue({
      side: 'BUY',
      setup: 'PULLBACK',
      reason: 'TREND_UP',
    });
    const no = sameDirNextMoveConfirms({
      side: 'SELL',
      closed1m: { open: 4340, close: 4340 },
      closedBars: [],
      regime: 'TREND_UP',
    });
    expect(no.ok).toBe(false);
    if (!no.ok) expect(no.reason).toMatch(/next entry BUY/);
  });

  it('blocks blind same-dir with no confirm', () => {
    vi.spyOn(softGate, 'peekNextEntrySide').mockReturnValue(null);
    const no = sameDirNextMoveConfirms({
      side: 'SELL',
      closed1m: null,
      closedBars: [],
    });
    expect(no.ok).toBe(false);
    if (!no.ok) expect(no.reason).toMatch(/nav next-move confirm/);
  });
});
