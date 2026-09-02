import { describe, expect, it } from 'vitest';
import {
  isJunkStockMarket,
  isUs100Market,
  pickDeployAccount,
  pickSwitchTarget,
  pickUs100,
} from './preferMarket';

const kimly = { epic: 'KIMLY', symbol: 'KIMLY', display_name: '$ Kimly', min_lot: 1 };
const eurusd = {
  epic: 'CS.D.EURUSD.MINI.IP',
  symbol: 'EURUSD',
  display_name: 'EUR/USD',
  min_lot: 0.1,
};
const gold = { epic: 'GOLD', symbol: 'GOLD', display_name: 'Gold', min_lot: 0.1 };
const us100 = {
  epic: 'US100',
  symbol: 'US100',
  display_name: 'US 100',
  min_lot: 0.1,
};

describe('pickSwitchTarget', () => {
  it('prefers US100 even when $ Kimly is first in A–Z catalog', () => {
    const pick = pickSwitchTarget([kimly, gold, eurusd, us100], 'KIMLY');
    expect(pick?.epic).toBe('US100');
  });

  it('never defaults to $ Kimly when Gold exists', () => {
    const pick = pickSwitchTarget([kimly, gold], null);
    expect(pick?.epic).toBe('GOLD');
    expect(isJunkStockMarket(kimly)).toBe(true);
  });

  it('does not pick the currently running epic when another market exists', () => {
    const pick = pickSwitchTarget([kimly, gold], 'GOLD');
    // Only junk alternative — stay on Gold rather than switch to Kimly
    expect(pick?.epic).toBe('GOLD');
  });

  it('switches off Kimly onto Gold', () => {
    const pick = pickSwitchTarget([kimly, gold], 'KIMLY');
    expect(pick?.epic).toBe('GOLD');
  });
});

describe('US100 helpers', () => {
  it('matches Capital-style US100 names', () => {
    expect(isUs100Market(us100)).toBe(true);
    expect(isUs100Market({ epic: 'NAS100', symbol: 'NAS100', display_name: 'Nasdaq 100' })).toBe(
      true,
    );
    expect(isUs100Market(kimly)).toBe(false);
    expect(pickUs100([kimly, us100])?.epic).toBe('US100');
  });
});

describe('pickDeployAccount', () => {
  it('picks a free client instead of the one already live', () => {
    const guntis = { account_id: 17 };
    const boss = { account_id: 18 };
    expect(pickDeployAccount([guntis, boss], [17])?.account_id).toBe(18);
  });
});
