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
  display_name: 'US Tech 100',
  min_lot: 0.1,
};
const defiance = {
  epic: 'QQQY',
  symbol: 'QQQY',
  display_name: 'Defiance Nasdaq 100 Enhanced Options & 0DTE Income ETF',
  min_lot: 1,
};

describe('pickSwitchTarget', () => {
  it('prefers real US100 even when $ Kimly and Defiance ETF are first', () => {
    const pick = pickSwitchTarget([kimly, defiance, gold, eurusd, us100], 'KIMLY');
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

  it('switches off Defiance ETF onto US Tech 100', () => {
    const pick = pickSwitchTarget([defiance, us100, kimly], defiance.epic);
    expect(pick?.epic).toBe('US100');
  });
});

describe('US100 helpers', () => {
  it('matches Capital-style US100 / US Tech 100 only', () => {
    expect(isUs100Market(us100)).toBe(true);
    expect(isUs100Market({ epic: 'NAS100', symbol: 'NAS100', display_name: 'US Tech 100' })).toBe(
      true,
    );
    expect(isUs100Market(kimly)).toBe(false);
    expect(isUs100Market(defiance)).toBe(false);
    expect(isJunkStockMarket(defiance)).toBe(true);
    expect(pickUs100([defiance, kimly, us100])?.epic).toBe('US100');
    expect(pickUs100([defiance, kimly])).toBeNull();
  });
});

describe('pickDeployAccount', () => {
  it('picks a free client instead of the one already live', () => {
    const guntis = { account_id: 17 };
    const boss = { account_id: 18 };
    expect(pickDeployAccount([guntis, boss], [17])?.account_id).toBe(18);
  });
});
