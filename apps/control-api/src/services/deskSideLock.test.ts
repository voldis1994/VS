import { describe, expect, it } from 'vitest';
import {
  allowDeskSameSide,
  deskConflictShouldExit,
  deskOpensOnEpic,
  type DeskOpenUnit,
} from './deskSideLock.js';

const units: DeskOpenUnit[] = [
  { id: 'boss', epic: 'GOLD', running: true, open_side: 'BUY', display_name: 'B.O.S.S.', client_id: 1 },
  { id: 'dim', epic: 'GOLD', running: true, open_side: null, display_name: 'DIMITRIJ', client_id: 2 },
  { id: 'gun', epic: 'SILVER', running: true, open_side: 'SELL', display_name: 'GUNTIS', client_id: 3 },
  { id: 'boss2', epic: 'GOLD', running: true, open_side: 'SELL', display_name: 'B.O.S.S. #2', client_id: 1 },
];

describe('deskSideLock — per-client isolation', () => {
  it('lists same-epic opens only for that client', () => {
    const g = deskOpensOnEpic(units, 'gold', undefined, 1);
    expect(g.buys).toHaveLength(1);
    expect(g.sells).toHaveLength(1); // boss2 same client
  });

  it('other client BUY does NOT block this client SELL', () => {
    // Client 2 (dim) free — Client 1 has BUY but must not lock Client 2
    const g = allowDeskSameSide(units, 'GOLD', 'SELL', 'dim', 2);
    expect(g.ok).toBe(true);
    expect(allowDeskSameSide(units, 'GOLD', 'BUY', 'dim', 2).ok).toBe(true);
  });

  it('same client still blocks opposite on epic', () => {
    // New account under client 1 while boss BUY + boss2 SELL already hedged —
    // allowDesk for a fresh id under client 1 vs existing BUY
    const solo: DeskOpenUnit[] = [
      { id: 'a', epic: 'GOLD', running: true, open_side: 'BUY', display_name: 'A', client_id: 9 },
      { id: 'b', epic: 'GOLD', running: true, open_side: null, display_name: 'B', client_id: 9 },
    ];
    expect(allowDeskSameSide(solo, 'GOLD', 'SELL', 'b', 9).ok).toBe(false);
    expect(allowDeskSameSide(solo, 'GOLD', 'BUY', 'b', 9).ok).toBe(true);
  });

  it('conflict exits BUY when dump and opposite SELL exists', () => {
    expect(deskConflictShouldExit('BUY', true, -0.004).exit).toBe(true);
    expect(deskConflictShouldExit('SELL', true, -0.004).exit).toBe(false);
    expect(deskConflictShouldExit('BUY', false, -0.004).exit).toBe(false);
  });
});
