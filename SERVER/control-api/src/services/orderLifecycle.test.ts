import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  _resetOrderLifecycleForTests,
  createManagedOrder,
  reconcileBeforeSubmit,
  submitManagedOrder,
} from './orderLifecycle.js';
import { DecisionCodes } from './decisionCodes.js';
import type { CapitalSession } from './capitalCom.js';

function mockSession(opts?: {
  positions?: Array<{
    deal_id: string;
    deal_reference: string | null;
    epic: string;
    direction: 'BUY' | 'SELL';
    size: number;
    open_level: number | null;
    upl: number | null;
    stop_level: number | null;
  }>;
}): CapitalSession {
  const positions = opts?.positions || [];
  return {
    base: 'https://demo-api-capital.backend-capital.com',
    apiKey: 'k',
    cst: 'c',
    securityToken: 's',
    close: async () => undefined,
    get: async (path: string) => {
      if (path.startsWith('/api/v1/positions')) {
        return {
          ok: true,
          status: 200,
          json: {
            positions: positions.map((p) => ({
              position: {
                dealId: p.deal_id,
                dealReference: p.deal_reference,
                direction: p.direction,
                size: p.size,
                level: p.open_level,
                upl: p.upl,
                stopLevel: p.stop_level,
              },
              market: { epic: p.epic },
            })),
          },
          text: '',
          headers: new Headers(),
        };
      }
      if (path.startsWith('/api/v1/confirms/')) {
        return {
          ok: true,
          status: 200,
          json: { dealId: 'DEAL-CONF' },
          text: '',
          headers: new Headers(),
        };
      }
      return { ok: true, status: 200, json: {}, text: '', headers: new Headers() };
    },
    post: async () => ({ ok: true, status: 200, json: {}, text: '', headers: new Headers() }),
    put: async () => ({ ok: true, status: 200, json: {}, text: '', headers: new Headers() }),
    del: async () => ({ ok: true, status: 200, json: {}, text: '', headers: new Headers() }),
  };
}

describe('P4 orderLifecycle', () => {
  beforeEach(() => _resetOrderLifecycleForTests());

  it('assigns client_order_id and SIGNAL_CREATED', () => {
    const o = createManagedOrder({
      account_id: 1,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
    });
    expect(o.client_order_id).toMatch(/^vs-/);
    expect(o.state).toBe('SIGNAL_CREATED');
    expect(o.code).toBe(DecisionCodes.SIGNAL_CREATED);
  });

  it('blocks duplicate when broker already has position', async () => {
    const session = mockSession({
      positions: [
        {
          deal_id: 'D1',
          deal_reference: 'R1',
          epic: 'GOLD',
          direction: 'BUY',
          size: 0.1,
          open_level: 4370,
          upl: 0,
          stop_level: 4360,
        },
      ],
    });
    const gate = await reconcileBeforeSubmit(session, 1, 'GOLD');
    expect(gate.allow_submit).toBe(false);
    expect(gate.broker_position?.deal_id).toBe('D1');
  });

  it('timeout does not blind-resubmit — stays ORDER_SUBMITTING until reconcile', async () => {
    const session = mockSession();
    const o = createManagedOrder({
      account_id: 2,
      epic: 'GOLD',
      direction: 'SELL',
      size: 0.2,
      submit_timeout_ms: 50,
    });
    const first = await submitManagedOrder(session, o, { forceTimeout: true });
    expect(first.ok).toBe(false);
    expect(first.order.state).toBe('ORDER_SUBMITTING');
    expect(first.order.code).toBe(DecisionCodes.NETWORK_TIMEOUT);

    const createFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: { dealReference: 'R-NEW' },
      deal_reference: 'R-NEW',
      detail: 'should not be called while inflight',
    }));
    const second = await submitManagedOrder(
      session,
      createManagedOrder({ account_id: 2, epic: 'GOLD', direction: 'SELL', size: 0.2 }),
      { createFn: createFn as never }
    );
    expect(second.duplicate_prevented).toBe(true);
    expect(createFn).not.toHaveBeenCalled();
  });

  it('records BROKER_REJECTED with precise detail', async () => {
    const session = mockSession();
    const o = createManagedOrder({
      account_id: 3,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
    });
    const createFn = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: { errorCode: 'error.insufficient.funds', message: 'Not enough funds' },
      detail: 'Capital.com open BUY GOLD failed HTTP 400: error.insufficient.funds',
    }));
    const res = await submitManagedOrder(session, o, { createFn: createFn as never });
    expect(res.ok).toBe(false);
    expect(res.order.state).toBe('BROKER_REJECTED');
    expect(res.order.code).toBe(DecisionCodes.BROKER_REJECTED);
    expect(res.detail).toMatch(/insufficient|400/i);
    expect(res.order.broker_error_code).toBe('error.insufficient.funds');
  });

  it('successful submit → FILLED / POSITION_OPEN via confirm', async () => {
    const session = mockSession();
    const o = createManagedOrder({
      account_id: 4,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
    });
    const createFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: { dealReference: 'REF-OK' },
      deal_reference: 'REF-OK',
      detail: 'Opened BUY GOLD',
    }));
    const res = await submitManagedOrder(session, o, { createFn: createFn as never });
    expect(res.ok).toBe(true);
    expect(res.order.deal_id).toBe('DEAL-CONF');
    expect(res.order.state).toBe('POSITION_OPEN');
    expect(res.order.code).toBe(DecisionCodes.POSITION_OPEN);
  });
});
