import { describe, expect, it } from 'vitest';
import {
  flipFilterReason,
  requiredFlipSide,
  sameDirectionBlocked,
} from './flipFilter.js';

describe('flipFilter — after close next must reverse', () => {
  it('allows any side when no prior close', () => {
    expect(sameDirectionBlocked('BUY', null)).toBe(false);
    expect(sameDirectionBlocked('SELL', null)).toBe(false);
    expect(requiredFlipSide(null)).toBeNull();
  });

  it('blocks BUY after BUY close; allows SELL', () => {
    expect(sameDirectionBlocked('BUY', 'BUY')).toBe(true);
    expect(sameDirectionBlocked('SELL', 'BUY')).toBe(false);
    expect(requiredFlipSide('BUY')).toBe('SELL');
  });

  it('blocks SELL after SELL close; allows BUY', () => {
    expect(sameDirectionBlocked('SELL', 'SELL')).toBe(true);
    expect(sameDirectionBlocked('BUY', 'SELL')).toBe(false);
    expect(requiredFlipSide('SELL')).toBe('BUY');
  });

  it('explains the block', () => {
    expect(flipFilterReason('BUY', 'BUY')).toMatch(/FLIP FILTER/);
    expect(flipFilterReason('BUY', 'BUY')).toMatch(/SELL/);
  });
});
