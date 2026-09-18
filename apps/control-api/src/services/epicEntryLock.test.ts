import { describe, expect, it } from 'vitest';
import { withEpicEntryLock } from './epicEntryLock.js';

describe('withEpicEntryLock', () => {
  it('serializes concurrent work on the same account+epic', async () => {
    const order: number[] = [];
    await Promise.all([
      withEpicEntryLock(1, 'GOLD', async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 30));
        order.push(2);
      }),
      withEpicEntryLock(1, 'GOLD', async () => {
        order.push(3);
        order.push(4);
      }),
    ]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('allows parallel work on different epics', async () => {
    const started: string[] = [];
    await Promise.all([
      withEpicEntryLock(1, 'GOLD', async () => {
        started.push('g');
        await new Promise((r) => setTimeout(r, 20));
      }),
      withEpicEntryLock(1, 'SILVER', async () => {
        started.push('s');
      }),
    ]);
    expect(started).toContain('g');
    expect(started).toContain('s');
  });
});
