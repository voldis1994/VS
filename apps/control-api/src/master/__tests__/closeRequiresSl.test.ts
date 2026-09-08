import { describe, expect, it } from 'vitest';
import { closeAllowedByStopLoss } from '../closeRequiresSl.js';

describe('closeAllowedByStopLoss (VS-System)', () => {
  it('allows sync when deal already gone on broker', () => {
    expect(
      closeAllowedByStopLoss({
        brokerFound: false,
        dbStopLoss: null,
      })
    ).toBe(true);
  });

  it('blocks naked broker position even if DB has SL', () => {
    expect(
      closeAllowedByStopLoss({
        brokerFound: true,
        brokerStopLoss: null,
        dbStopLoss: 2650,
      })
    ).toBe(false);
  });

  it('allows when broker shows stopLoss', () => {
    expect(
      closeAllowedByStopLoss({
        brokerFound: true,
        brokerStopLoss: 2649.5,
        dbStopLoss: null,
      })
    ).toBe(true);
  });

  it('when broker unread, requires DB SL', () => {
    expect(
      closeAllowedByStopLoss({
        brokerFound: null,
        dbStopLoss: null,
      })
    ).toBe(false);
    expect(
      closeAllowedByStopLoss({
        brokerFound: null,
        dbStopLoss: 2650,
      })
    ).toBe(true);
  });

  it('treats MT4 OrderStopLoss 0 as naked (not a protective stop)', () => {
    expect(
      closeAllowedByStopLoss({
        brokerFound: true,
        brokerStopLoss: 0,
        dbStopLoss: 2650,
      })
    ).toBe(false);
    expect(
      closeAllowedByStopLoss({
        brokerFound: null,
        dbStopLoss: 0,
      })
    ).toBe(false);
    expect(
      closeAllowedByStopLoss({
        brokerFound: true,
        brokerStopLoss: '0',
      })
    ).toBe(false);
  });
});
