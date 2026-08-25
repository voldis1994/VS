import { describe, expect, it } from 'vitest';

/** Mirror robotDesk hedge detection (kept local there; logic asserted here). */
function isHedgedOpens(
  positions: { direction: 'BUY' | 'SELL' }[]
): boolean {
  let buy = false;
  let sell = false;
  for (const p of positions) {
    if (p.direction === 'BUY') buy = true;
    if (p.direction === 'SELL') sell = true;
  }
  return buy && sell;
}

describe('hedge detection', () => {
  it('detects BUY+SELL as hedge', () => {
    expect(
      isHedgedOpens([
        { direction: 'BUY' },
        { direction: 'SELL' },
      ])
    ).toBe(true);
  });

  it('same-side stack is not hedge', () => {
    expect(isHedgedOpens([{ direction: 'SELL' }, { direction: 'SELL' }])).toBe(false);
  });
});
