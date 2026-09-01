import { describe, expect, it } from 'vitest';
import { isEurUsdMarket, offerEurUsdShortcut, pickDeployAccount, pickSwitchTarget } from './preferMarket';

const kimly = { epic: 'KIMLY', symbol: 'KIMLY', display_name: '$ Kimly', min_lot: 1 };
const eurusd = { epic: 'CS.D.EURUSD.MINI.IP', symbol: 'EURUSD', display_name: 'EUR/USD', min_lot: 0.1 };
const gold = { epic: 'GOLD', symbol: 'GOLD', display_name: 'Gold', min_lot: 0.1 };

describe('pickSwitchTarget', () => {
  it('prefers EUR/USD even when $ Kimly is first in A–Z catalog', () => {
    const pick = pickSwitchTarget([kimly, gold, eurusd], 'KIMLY');
    expect(pick?.epic).toBe(eurusd.epic);
  });

  it('matches Capital-style EURUSD epic', () => {
    expect(isEurUsdMarket(eurusd)).toBe(true);
    expect(isEurUsdMarket(kimly)).toBe(false);
  });

  it('does not offer → EUR/USD on Gold (only leftover stocks like Kimly)', () => {
    expect(offerEurUsdShortcut(gold)).toBe(false);
    expect(offerEurUsdShortcut(eurusd)).toBe(false);
    expect(offerEurUsdShortcut(kimly)).toBe(true);
  });

  it('does not pick the currently running epic when another market exists', () => {
    const pick = pickSwitchTarget([kimly, gold], 'KIMLY');
    expect(pick?.epic).toBe('GOLD');
  });
});

describe('pickDeployAccount', () => {
  it('picks a free client instead of the one already live', () => {
    const guntis = { account_id: 17 };
    const boss = { account_id: 18 };
    expect(pickDeployAccount([guntis, boss], [17])?.account_id).toBe(18);
  });
});
