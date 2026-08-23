import { describe, expect, it } from 'vitest';
import { filterMarkets } from '../lib/markets';

describe('filterMarkets', () => {
  const rows = [
    { symbol: 'GOLD', epic: 'GOLD', display_name: 'Gold Spot' },
    { symbol: 'ARB', epic: 'ARB-US', display_name: 'ARB Corporation' },
    { symbol: 'ARKK', epic: 'ARKK', display_name: 'ARK Innovation ETF' },
  ];

  it('filters by display name', () => {
    expect(filterMarkets(rows, 'gold')).toHaveLength(1);
    expect(filterMarkets(rows, 'gold')[0]?.display_name).toBe('Gold Spot');
  });

  it('filters by epic', () => {
    expect(filterMarkets(rows, 'arkk')).toHaveLength(1);
  });

  it('returns slice when query empty', () => {
    expect(filterMarkets(rows, '', 2)).toHaveLength(2);
  });
});
