import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { createOrderRecord, transitionOrder } from './orderStateMachine.js';
import { resetDurableOrderStoreForTests } from './durableOrderStore.js';

describe('ghost intents must not freeze SCAN', () => {
  it('broker-flat releases SUBMITTING + POSITION_OPEN so duplicate check is empty', () => {
    const store = resetDurableOrderStoreForTests(
      join(tmpdir(), `vs-ghost-${Date.now()}.json`)
    );
    let order = createOrderRecord({
      intent_id: 'i1',
      client_order_id: 'c1',
      client_id: 1,
      account_id: 42,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      strategy_version: 't',
      config_version: 't',
      decision_id: 'd1',
    });
    order = transitionOrder(order, 'RISK_ACCEPTED');
    order = transitionOrder(order, 'ORDER_CREATED');
    order = transitionOrder(order, 'SUBMITTING');
    store.put(order);
    store.beginSubmission({
      client_order_id: 'c1',
      intent_id: 'i1',
      setup_id: 's1',
      client_id: 1,
      account_id: 42,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      state: 'BROKER_ACCEPTED',
    });
    expect(store.openIntents(42, 'GOLD').length).toBeGreaterThan(0);
    expect(store.hasUnresolvedSubmission(42, 'GOLD')).toBe(true);

    const n = store.releaseGhostIntents(42, 'GOLD');
    expect(n).toBeGreaterThan(0);
    expect(store.openIntents(42, 'GOLD').length).toBe(0);
    expect(store.hasUnresolvedSubmission(42, 'GOLD')).toBe(false);
  });
});
