import { describe, expect, it } from 'vitest';
import { formatMarketInfo, marketAllowsTrading } from './robotDesk.js';

describe('formatMarketInfo (#136 / Aug13 park messaging)', () => {
  it('screams MARKET CLOSED when not tradeable', () => {
    const line = formatMarketInfo('CLOSED', false, 15);
    expect(line).toMatch(/MARKET CLOSED/);
    expect(line).toMatch(/Capital=CLOSED/);
    expect(line).toMatch(/PARKED/);
    expect(line).toMatch(/TRADEABLE/);
    expect(line).toMatch(/NO orders/);
  });

  it('missing status shows UNKNOWN — does not invent CLOSED label from clock', () => {
    expect(formatMarketInfo(null, false)).toMatch(/Capital=UNKNOWN/);
  });

  it('shows OPEN when tradeable', () => {
    expect(formatMarketInfo('TRADEABLE', true)).toMatch(/MARKET OPEN/);
  });
});

describe('marketAllowsTrading (#17)', () => {
  it('missing/unknown status → NO NEW ENTRY', () => {
    expect(marketAllowsTrading(null)).toBe(false);
    expect(marketAllowsTrading(undefined)).toBe(false);
    expect(marketAllowsTrading('')).toBe(false);
    expect(marketAllowsTrading('   ')).toBe(false);
  });

  it('TRADEABLE/OPEN allow trading; CLOSED/SUSPENDED/UNKNOWN do not', () => {
    expect(marketAllowsTrading('TRADEABLE')).toBe(true);
    expect(marketAllowsTrading('OPEN')).toBe(true);
    expect(marketAllowsTrading('CLOSED')).toBe(false);
    expect(marketAllowsTrading('SUSPENDED')).toBe(false);
    expect(marketAllowsTrading('UNKNOWN')).toBe(false);
    expect(marketAllowsTrading('EDIT')).toBe(false);
  });
});
