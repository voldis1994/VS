import { describe, expect, it } from 'vitest';
import { formatMarketInfo } from './robotDesk.js';

describe('formatMarketInfo (#136 / Aug13 park messaging)', () => {
  it('screams MARKET CLOSED when not tradeable', () => {
    const line = formatMarketInfo('CLOSED', false, 15);
    expect(line).toMatch(/MARKET CLOSED/);
    expect(line).toMatch(/Capital=CLOSED/);
    expect(line).toMatch(/PARKED/);
    expect(line).toMatch(/TRADEABLE/);
    expect(line).toMatch(/NO orders/);
  });

  it('shows OPEN when tradeable', () => {
    expect(formatMarketInfo('TRADEABLE', true)).toMatch(/MARKET OPEN/);
  });
});
