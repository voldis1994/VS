/**
 * VS CORE — Exit Strategy joint audit matrix A–P
 * Uses production decideBestOutcomeExit / exitLifecycle / durable markPositionClosed.
 */
import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  favorableMove,
  thesisFailureReason,
  type ExitSnapshot,
} from './exitManage.js';
import {
  canIssueClose,
  decideCloseFinalize,
  decideExternalFlatClear,
} from './exitLifecycle.js';
import {
  createOrderRecord,
  transitionOrder,
} from '../vs-core/orderStateMachine.js';
import { resetDurableOrderStoreForTests } from '../vs-core/durableOrderStore.js';
import { join } from 'path';
import { tmpdir } from 'os';

function snap(
  partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }
): ExitSnapshot {
  return {
    mfe: 0,
    mae: 0,
    peak_retention: null,
    entry_at: new Date().toISOString(),
    regime: 'TREND_UP',
    entry_setup: 'PULLBACK',
    entry_regime: 'TREND_UP',
    ...partial,
  };
}

describe('Exit matrix A–P', () => {
  it('A) LONG hard-stop exit', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE', entry_setup: 'PULLBACK' }),
      1994
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('B) SHORT hard-stop exit', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 2000,
        regime: 'RANGE',
        entry_setup: 'PULLBACK',
        entry_regime: 'TREND_DOWN',
      }),
      2006
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
    expect(favorableMove('SELL', 2000, 2006)).toBeLessThan(0);
  });

  it('C) LONG target exit', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, mfe: 8, entry_setup: 'CONTINUATION' }),
      2005
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('D) SHORT target exit', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 2000,
        mfe: 8,
        entry_setup: 'CONTINUATION',
        entry_regime: 'TREND_DOWN',
        regime: 'TREND_DOWN',
      }),
      1995
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('E) valid position remains open when no exit condition exists', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, mfe: 0.4, entry_setup: 'PULLBACK' }),
      2000.5
    );
    expect(d.exit).toBe(false);
    expect(d.reason).toBe('');
  });

  it('F) reversal/invalidation LONG (with-trend setup + opposite regime)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_DOWN',
        entry_setup: 'PULLBACK',
        mfe: 2,
      }),
      2001
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ThesisFailure/);
  });

  it('G) reversal/invalidation SHORT (with-trend setup + opposite regime)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 2000,
        regime: 'TREND_UP',
        entry_setup: 'CONTINUATION',
        entry_regime: 'TREND_DOWN',
      }),
      1999
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ThesisFailure/);
  });

  it('H) failed-breakout position management — opposite regime is NOT thesis kill', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 2000,
        entry_setup: 'FAILED_BREAKOUT',
        entry_regime: 'FAILED_BREAKOUT_UP',
        regime: 'TREND_UP',
        mfe: 0.5,
      }),
      1999.5
    );
    expect(d.exit).toBe(false);
    expect(thesisFailureReason('SELL', 'TREND_UP', 'FAILED_BREAKOUT')).toBeNull();
  });

  it('I) FADE/exhaustion position management — opposite regime is NOT thesis kill', () => {
    expect(thesisFailureReason('BUY', 'TREND_DOWN', 'FADE')).toBeNull();
    expect(thesisFailureReason('SELL', 'TREND_UP', 'REVERSAL')).toBeNull();
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        entry_setup: 'FADE',
        entry_regime: 'TREND_DOWN',
        regime: 'TREND_DOWN',
        mfe: 0.3,
      }),
      2000.4
    );
    expect(d.exit).toBe(false);
  });

  it('J) no look-ahead — Exit uses only snapshot + mid at T (injectable clock)', () => {
    const entryAt = '2026-08-15T12:00:00.000Z';
    const t0 = Date.parse(entryAt);
    // At T+10s: hold
    const early = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: entryAt,
        mfe: 1,
        entry_setup: 'PULLBACK',
        regime: 'TREND_UP',
      }),
      2000.5,
      t0 + 10_000
    );
    expect(early.exit).toBe(false);
    // Future mid must be passed by caller — function has no bar history / no future fetch
    const futureMid = 2100;
    const atT = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: entryAt,
        mfe: 0,
        entry_setup: 'PULLBACK',
      }),
      2000.1,
      t0 + 5_000
    );
    expect(atT.exit).toBe(false);
    // Using a later mid at same clock is caller's data at that T — TimeDecay must not fire from future heldMs
    const noFutureTime = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: entryAt,
        mfe: 2,
        entry_setup: 'PULLBACK',
      }),
      futureMid,
      t0 + 5_000
    );
    // Target hits on mid alone — legitimate at T if mid is current; not look-ahead from bars
    expect(noFutureTime.exit).toBe(true);
    expect(noFutureTime.reason).toMatch(/Target/);
    // TimeDecay only when nowMs - entry_at exceeds threshold (not Date.now smuggled)
    const decay = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: entryAt,
        mfe: 1,
        entry_setup: 'PULLBACK',
        regime: 'TREND_UP',
      }),
      2000.5,
      t0 + 100_000
    );
    expect(decay.exit).toBe(true);
    expect(decay.reason).toMatch(/TimeDecay/);
  });

  it('K) duplicate close prevention', () => {
    expect(canIssueClose({ open_side: 'BUY' }).issue).toBe(true);
    expect(canIssueClose({ open_side: 'BUY', close_in_flight: true }).issue).toBe(false);
    expect(canIssueClose({ open_side: 'BUY', close_pending: true }).reason).toBe('CLOSE_PENDING');
    expect(canIssueClose({ open_side: null }).reason).toBe('NO_POSITION');
  });

  it('L) broker close rejection keeps position open', () => {
    const fin = decideCloseFinalize({
      closeHttpOk: false,
      closeDetail: 'HTTP 400 reject',
      brokerListOk: true,
      stillOpenOnBroker: true,
    });
    expect(fin.action).toBe('KEEP_OPEN');
  });

  it('M) broker close retry/recovery — pending until flat', () => {
    const pending = decideCloseFinalize({
      closeHttpOk: true,
      brokerListOk: true,
      stillOpenOnBroker: true,
    });
    expect(pending.action).toBe('CLOSE_PENDING');
    const listDown = decideCloseFinalize({
      closeHttpOk: true,
      brokerListOk: false,
      stillOpenOnBroker: null,
    });
    expect(listDown.action).toBe('CLOSE_PENDING');
    const recovered = decideCloseFinalize({
      closeHttpOk: true,
      brokerListOk: true,
      stillOpenOnBroker: false,
    });
    expect(recovered.action).toBe('FINALIZE_CLOSED');
  });

  it('N) restart with existing open position — external flat / adopt rules', () => {
    expect(
      decideExternalFlatClear({
        localOpen: true,
        brokerListOk: true,
        brokerHasPosition: true,
      })
    ).toBe('HOLD');
    expect(
      decideExternalFlatClear({
        localOpen: false,
        brokerListOk: true,
        brokerHasPosition: true,
      })
    ).toBe('ADOPT');
    expect(
      decideExternalFlatClear({
        localOpen: true,
        brokerListOk: true,
        brokerHasPosition: false,
      })
    ).toBe('CLEAR_LOCAL');
    expect(
      decideExternalFlatClear({
        localOpen: true,
        brokerListOk: false,
        brokerHasPosition: false,
      })
    ).toBe('HOLD');
  });

  it('O) POSITION_CLOSED only after broker confirmation', () => {
    const optimistic = decideCloseFinalize({
      closeHttpOk: true,
      brokerListOk: null,
      stillOpenOnBroker: null,
    });
    expect(optimistic.action).not.toBe('FINALIZE_CLOSED');
    const confirmed = decideCloseFinalize({
      closeHttpOk: true,
      brokerListOk: true,
      stillOpenOnBroker: false,
    });
    expect(confirmed.action).toBe('FINALIZE_CLOSED');

    const store = resetDurableOrderStoreForTests(
      join(tmpdir(), `vs-exit-o-${Date.now()}.json`)
    );
    let order = createOrderRecord({
      intent_id: 'i1',
      client_order_id: 'c1',
      client_id: 1,
      account_id: 9,
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
      setup_id: 's1',
      client_id: 1,
      account_id: 9,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      state: 'POSITION_OPEN',
      deal_reference: 'r1',
      deal_id: 'deal1',
    });
    expect(store.openLedger(9, 'GOLD').some((L) => L.state === 'POSITION_OPEN')).toBe(true);
    const n = store.markPositionClosed(9, 'GOLD', 'broker flat');
    expect(n).toBeGreaterThanOrEqual(1);
    expect(store.getByIntent('i1')?.state).toBe('POSITION_CLOSED');
    expect(store.getLedger('c1')?.state).toBe('POSITION_CLOSED');
    // Idempotent second mark
    expect(store.markPositionClosed(9, 'GOLD')).toBe(0);
  });

  it('P) Strategy/Exit authority boundary — Exit does not re-gate entry via regime', () => {
    // Missing setup: no ThesisFailure (cannot invent entry permission)
    expect(thesisFailureReason('BUY', 'TREND_DOWN', null)).toBeNull();
    expect(thesisFailureReason('BUY', 'TREND_DOWN', undefined)).toBeNull();
    // Countertrend families preserved
    for (const setup of ['FADE', 'REVERSAL', 'FAILED_BREAKOUT', 'RANGE_REJECTION']) {
      expect(thesisFailureReason('BUY', 'TREND_DOWN', setup)).toBeNull();
      expect(thesisFailureReason('SELL', 'TREND_UP', setup)).toBeNull();
    }
    // With-trend families still invalidate on opposite live regime
    expect(thesisFailureReason('BUY', 'TREND_DOWN', 'PULLBACK')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('SELL', 'BREAKOUT_UP', 'BREAKOUT')).toMatch(/ThesisFailure/);
    // Exit never calls evaluateStrategy — decideBestOutcomeExit has no setup qualification path
    const holdFade = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 2000,
        entry_setup: 'FADE',
        regime: 'TREND_UP',
        mfe: 0.2,
      }),
      1999.8
    );
    expect(holdFade.exit).toBe(false);
  });
});

describe('Exit helpers — LONG/SHORT symmetry', () => {
  it('favorableMove is side-correct', () => {
    expect(favorableMove('BUY', 2000, 2005)).toBe(5);
    expect(favorableMove('SELL', 2000, 2005)).toBe(-5);
    expect(favorableMove('SELL', 2000, 1995)).toBe(5);
  });

  it('GaveBackPlus / PeakProtection / harvest work for SELL', () => {
    const gave = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 2000,
        regime: 'TREND_DOWN',
        entry_setup: 'PULLBACK',
        mfe: 2.5,
        peak_retention: 0,
      }),
      2000.2
    );
    expect(gave.exit).toBe(true);
    expect(gave.reason).toMatch(/GaveBackPlus/);

    const peak = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 2000,
        regime: 'TREND_DOWN',
        entry_setup: 'CONTINUATION',
        mfe: 8,
        peak_retention: 0.2,
      }),
      1998.4
    );
    expect(peak.exit).toBe(true);
    expect(peak.reason).toMatch(/PeakProtection/);
  });
});
