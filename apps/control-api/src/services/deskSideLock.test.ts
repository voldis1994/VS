import { describe, expect, it } from 'vitest';
import {
  allowDeskSameSide,
  deskConflictShouldExit,
  deskOpensOnEpic,
  type DeskOpenUnit,
} from './deskSideLock.js';

const units: DeskOpenUnit[] = [
  { id: 'boss', epic: 'GOLD', running: true, open_side: 'BUY', display_name: 'B.O.S.S.' },
  { id: 'dim', epic: 'GOLD', running: true, open_side: null, display_name: 'DIMITRIJ' },
  { id: 'gun', epic: 'SILVER', running: true, open_side: 'SELL', display_name: 'GUNTIS' },
];

describe('deskSideLock', () => {
  it('lists same-epic opens only', () => {
    const g = deskOpensOnEpic(units, 'gold');
    expect(g.buys).toHaveLength(1);
    expect(g.sells).toHaveLength(0);
  });

  it('blocks opposite SELL while peer BUY is open', () => {
    const g = allowDeskSameSide(units, 'GOLD', 'SELL', 'dim');
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/DESK lock/);
    expect(allowDeskSameSide(units, 'GOLD', 'BUY', 'dim').ok).toBe(true);
  });

  it('conflict exits BUY when dump and opposite SELL exists', () => {
    expect(deskConflictShouldExit('BUY', true, -0.004).exit).toBe(true);
    expect(deskConflictShouldExit('SELL', true, -0.004).exit).toBe(false);
    expect(deskConflictShouldExit('BUY', false, -0.004).exit).toBe(false);
  });
});
