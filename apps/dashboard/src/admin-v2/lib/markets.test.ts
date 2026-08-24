import { describe, expect, it } from 'vitest';
import { filterMarkets } from '../lib/markets';

describe('filterMarkets', () => {
  const rows = [
    { symbol: 'GOLD', epic: 'GOLD', display_name: 'Gold Spot' },
    { symbol: 'LGB', epic: '1362', display_name: 'Lingbao Gold Group Co Ltd' },
    { symbol: 'WGG', epic: '3939', display_name: 'Wanguo Gold Group Ltd' },
    { symbol: 'ARB', epic: 'ARB-US', display_name: 'ARB Corporation' },
    { symbol: 'ARKK', epic: 'ARKK', display_name: 'ARK Innovation ETF' },
  ];

  it('filters by display name', () => {
    expect(filterMarkets(rows, 'gold')).toHaveLength(3);
    expect(filterMarkets(rows, 'gold')[0]?.display_name).toBe('Gold Spot');
  });

  it('ranks Capital GOLD above equity names containing gold', () => {
    const hit = filterMarkets(rows, 'gold g');
    expect(hit[0]?.epic).toBe('GOLD');
  });

  it('filters by epic', () => {
    expect(filterMarkets(rows, 'arkk')).toHaveLength(1);
  });

  it('returns slice when query empty', () => {
    expect(filterMarkets(rows, '', 2)).toHaveLength(2);
  });
});
