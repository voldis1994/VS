/**
 * HIGH-gap fixes B3–B7 — fail-closed money path, durable close, boot gate, encryption, LIVE.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync } from 'fs';
import {
  assertAuthoritativeOpener,
  assertEntriesAllowed,
  resetMoneyPathGateForTests,
  setMoneyPathRecoveryResult,
} from './moneyPathGate.js';
import {
  resetDurableOrderStoreForTests,
  DurableOrderStore,
} from './durableOrderStore.js';
import { canIssueClose, decideCloseFinalize } from '../services/exitLifecycle.js';
import {
  encrypt,
  decrypt,
  isUnsafeMasterEncryptionKey,
  EncryptionKeyError,
} from '../security/encryption.js';
import { createOrderRecord, transitionOrder } from './orderStateMachine.js';

describe('B3 alternate opener fail-closed', () => {
  it('intentFanout and admin_trading_orders cannot open', () => {
    const a = assertAuthoritativeOpener('intentFanout');
    const b = assertAuthoritativeOpener('admin_trading_orders');
    expect(a.allowed).toBe(false);
    expect(b.allowed).toBe(false);
    expect(a.code).toBe('ALTERNATE_OPENER_DISABLED');
  });
});

describe('B5 money-path gate blocks entries until recovery', () => {
  beforeEach(() => {
    resetMoneyPathGateForTests();
  });

  it('entries blocked by default', () => {
    const g = assertEntriesAllowed();
    expect(g.allowed).toBe(false);
    expect(g.code).toBe('MONEY_PATH_NOT_READY');
  });

  it('entries allowed only after recovery PASS', () => {
    setMoneyPathRecoveryResult({
      ok: true,
      entries_allowed: true,
      reason_code: null,
      detail: 'ok',
    });
    expect(assertEntriesAllowed().allowed).toBe(true);
  });

  it('recovery FAIL keeps entries blocked', () => {
    setMoneyPathRecoveryResult({
      ok: false,
      entries_allowed: false,
      reason_code: 'DURABLE_CORRUPT',
      detail: 'bad',
    });
    expect(assertEntriesAllowed().allowed).toBe(false);
  });
});

describe('B4 durable CLOSE_PENDING survives reload', () => {
  it('markClosePending → new store instance still pending; flat clears', () => {
    const path = join(tmpdir(), `vs-close-pend-${Date.now()}.json`);
    const store = resetDurableOrderStoreForTests(path);
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
    for (const st of [
      'RISK_ACCEPTED',
      'ORDER_CREATED',
      'SUBMITTING',
      'BROKER_ACCEPTED',
      'FILLED',
      'POSITION_OPEN',
    ] as const) {
      order = transitionOrder(order, st);
      store.put(order);
    }
    store.beginSubmission({
      client_order_id: 'c1',
      intent_id: 'i1',
      setup_id: 's',
      client_id: 1,
      account_id: 42,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      state: 'POSITION_OPEN',
      deal_reference: 'r',
      deal_id: 'deal1',
    });
    store.markClosePending({
      account_id: 42,
      epic: 'GOLD',
      deal_id: 'deal1',
      client_id: 1,
      direction: 'BUY',
    });
    expect(store.isClosePending(42, 'GOLD')).toBe(true);
    expect(canIssueClose({ open_side: 'BUY', close_pending: true }).issue).toBe(false);

    const reloaded = new DurableOrderStore(path);
    expect(reloaded.isClosePending(42, 'GOLD')).toBe(true);
    expect(reloaded.listClosePending().length).toBeGreaterThanOrEqual(1);

    expect(
      decideCloseFinalize({
        closeHttpOk: true,
        brokerListOk: true,
        stillOpenOnBroker: false,
      }).action
    ).toBe('FINALIZE_CLOSED');
    reloaded.markPositionClosed(42, 'GOLD', 'broker flat after restart');
    expect(reloaded.isClosePending(42, 'GOLD')).toBe(false);
  });

  it('restart cases: before close / after request / unknown outcome', () => {
    expect(canIssueClose({ open_side: 'BUY', close_pending: false }).issue).toBe(true);
    expect(canIssueClose({ open_side: 'BUY', close_pending: true }).reason).toBe('CLOSE_PENDING');
    expect(
      decideCloseFinalize({
        closeHttpOk: true,
        brokerListOk: true,
        stillOpenOnBroker: true,
      }).action
    ).toBe('CLOSE_PENDING');
    expect(
      decideCloseFinalize({
        closeHttpOk: true,
        brokerListOk: true,
        stillOpenOnBroker: false,
      }).action
    ).toBe('FINALIZE_CLOSED');
    expect(
      decideCloseFinalize({
        closeHttpOk: true,
        brokerListOk: false,
        stillOpenOnBroker: null,
      }).action
    ).toBe('CLOSE_PENDING');
    expect(
      decideCloseFinalize({
        closeHttpOk: false,
        brokerListOk: true,
        stillOpenOnBroker: true,
      }).action
    ).toBe('KEEP_OPEN');
  });
});

describe('B5 corrupt durable detection', () => {
  it('corrupt durable → getLoadError FAIL CLOSED signal', () => {
    const path = join(tmpdir(), `vs-corrupt-${Date.now()}.json`);
    writeFileSync(path, '{not-json');
    const store = new DurableOrderStore(path);
    expect(store.getLoadError()).toMatch(/DURABLE_CORRUPT/);
  });
});

describe('B6 MASTER_ENCRYPTION_KEY fail-closed', () => {
  const prev = process.env.MASTER_ENCRYPTION_KEY;

  afterEach(() => {
    if (prev === undefined) delete process.env.MASTER_ENCRYPTION_KEY;
    else process.env.MASTER_ENCRYPTION_KEY = prev;
  });

  it('detects missing/default/short keys', () => {
    expect(isUnsafeMasterEncryptionKey(undefined)).toBe(true);
    expect(isUnsafeMasterEncryptionKey('')).toBe(true);
    expect(isUnsafeMasterEncryptionKey('CHANGE_ME_32_BYTE_HEX_OR_BASE64_KEY_HERE')).toBe(true);
    expect(isUnsafeMasterEncryptionKey('short')).toBe(true);
    expect(isUnsafeMasterEncryptionKey('a-sufficiently-long-unique-secret-key')).toBe(false);
  });

  it('encrypt throws without safe key', () => {
    delete process.env.MASTER_ENCRYPTION_KEY;
    expect(() => encrypt('x')).toThrow(EncryptionKeyError);
  });

  it('encrypt/decrypt round-trip with valid key', () => {
    process.env.MASTER_ENCRYPTION_KEY = 'test-key-for-encryption-tests-ok';
    const enc = encrypt('secret-value');
    expect(decrypt(enc.ciphertext, enc.iv, enc.tag)).toBe('secret-value');
  });
});

describe('B7 LIVE enablement policy', () => {
  it('LIVE defaults off in test process', () => {
    expect(process.env.LIVE_TRADING_ENABLED === 'true').toBe(false);
  });
});
