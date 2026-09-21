import { describe, expect, it } from 'vitest';
import { capitalOhlcFieldMid, parseCapitalUpdateMs } from './capitalCom.js';

describe('capitalOhlcFieldMid', () => {
  it('averages bid+ask so history matches live Capital mid', () => {
    expect(capitalOhlcFieldMid({ bid: 4360.1, ask: 4360.9 })).toBeCloseTo(4360.5, 5);
  });

  it('falls back to bid or ask alone', () => {
    expect(capitalOhlcFieldMid({ bid: 100 })).toBe(100);
    expect(capitalOhlcFieldMid({ ask: 101 })).toBe(101);
  });
});

describe('parseCapitalUpdateMs', () => {
  it('parses Capital updateTime for 10s buckets', () => {
    const ms = parseCapitalUpdateMs('2024-08-21T05:19:10.000Z');
    expect(ms).toBe(Date.parse('2024-08-21T05:19:10.000Z'));
  });

  it('returns null on garbage', () => {
    expect(parseCapitalUpdateMs(null)).toBeNull();
    expect(parseCapitalUpdateMs('not-a-date')).toBeNull();
  });
});
