import { describe, expect, it, afterEach } from 'vitest';
import {
  TRADE_EVERYTHING_AT_START,
  tradeOpenAtStart,
  _setTradeOpenAtStartForTests,
} from './tradeOpenPolicy.js';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import { structureGate } from './structureEntry.js';
import { sameDirectionBlocked } from './flipFilter.js';
import { sameDirNextMoveConfirms } from './sameDirNextMove.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number): TenSecBar {
  return {
    open_time_ms: 0,
    open,
    high: Math.max(open, close) + 0.12,
    low: Math.min(open, close) - 0.06,
    close,
    ticks: 12,
  };
}

describe('tradeOpenAtStart ultimate', () => {
  afterEach(() => _setTradeOpenAtStartForTests(null));

  it('defaults ON', () => {
    expect(TRADE_EVERYTHING_AT_START).toBe(true);
    expect(tradeOpenAtStart()).toBe(true);
  });

  it('opens COMPRESSION fade and skips flip / same-dir gates', () => {
    _setTradeOpenAtStartForTests(null);
    expect(decideEntryFrom10sRegime(bar(2000, 1999.5), 'COMPRESSION')?.direction).toBe('BUY');
    expect(sameDirectionBlocked('BUY', 'BUY', Date.now() - 1000, Date.now(), { wasLoss: true })).toBe(
      false
    );
    expect(sameDirNextMoveConfirms({ side: 'BUY' }).ok).toBe(true);
    const buy = { direction: 'BUY' as const, setup: 'FADE' as const, reason: 't' };
    expect(structureGate(buy, 'TRANSITION', bar(2000, 1999.5), null, null).ok).toBe(true);
  });
});
