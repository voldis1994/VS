import { describe, expect, it } from 'vitest';
import { shouldClearBrokerGhost } from './robotDesk.js';

describe('shouldClearBrokerGhost', () => {
  it('clears fast when Capital list is empty and no dealId (unconfirmed ghost)', () => {
    expect(
      shouldClearBrokerGhost({
        broker_flat_streak: 1,
        ms_since_entry: 1_500,
        deal_id: null,
        list_ok: true,
      })
    ).toBe(true);
  });

  it('keeps brief lag guard right after a confirmed fill', () => {
    expect(
      shouldClearBrokerGhost({
        broker_flat_streak: 1,
        ms_since_entry: 500,
        deal_id: 'deal-1',
        list_ok: true,
      })
    ).toBe(false);
  });

  it('clears confirmed ghost after short empty streak', () => {
    expect(
      shouldClearBrokerGhost({
        broker_flat_streak: 2,
        ms_since_entry: 2_000,
        deal_id: 'deal-1',
        list_ok: true,
      })
    ).toBe(true);
  });

  it('clears unconfirmed ghost when position list keeps failing', () => {
    expect(
      shouldClearBrokerGhost({
        broker_flat_streak: 0,
        ms_since_entry: 3_000,
        deal_id: null,
        list_ok: false,
        sync_fail_streak: 4,
      })
    ).toBe(true);
  });

  it('does not clear a dealId ghost just because list failed', () => {
    expect(
      shouldClearBrokerGhost({
        broker_flat_streak: 0,
        ms_since_entry: 10_000,
        deal_id: 'deal-1',
        list_ok: false,
        sync_fail_streak: 10,
      })
    ).toBe(false);
  });
});
