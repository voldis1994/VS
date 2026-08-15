import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  _resetCapitalSessionManagerForTests,
  capitalFeedAgeMs,
  getCapitalSessionHealth,
  isCapitalFeedStale,
  parseCapitalBrokerError,
  recordCapitalFeedTick,
  recordCapitalSessionError,
  recordCapitalSessionOk,
} from './capitalSessionManager.js';
import { DecisionCodes } from './decisionCodes.js';
import type { CapitalSession } from './capitalCom.js';

function fakeSession(): CapitalSession {
  return {
    base: 'https://demo-api-capital.backend-capital.com',
    apiKey: 'k',
    cst: 'CST1',
    securityToken: 'SEC1',
    close: async () => undefined,
    get: async () => ({ ok: true, status: 200, json: {}, text: '', headers: new Headers() }),
    post: async () => ({ ok: true, status: 200, json: {}, text: '', headers: new Headers() }),
    put: async () => ({ ok: true, status: 200, json: {}, text: '', headers: new Headers() }),
    del: async () => ({ ok: true, status: 200, json: {}, text: '', headers: new Headers() }),
  };
}

describe('P2 capitalSessionManager', () => {
  beforeEach(() => _resetCapitalSessionManagerForTests());

  it('parses 401 as SESSION_EXPIRED', () => {
    const p = parseCapitalBrokerError({
      status: 401,
      json: { errorCode: 'error.security.token-invalid' },
      detail: 'Unauthorized',
    });
    expect(p.code).toBe(DecisionCodes.SESSION_EXPIRED);
  });

  it('parses 429 as RATE_LIMITED', () => {
    const p = parseCapitalBrokerError({
      status: 429,
      json: { errorCode: 'error.too-many.requests' },
      text: 'too many',
    });
    expect(p.code).toBe(DecisionCodes.RATE_LIMITED);
  });

  it('tracks CST session health OK after success', () => {
    recordCapitalSessionOk(7, fakeSession());
    const h = getCapitalSessionHealth(7);
    expect(h.has_cst).toBe(true);
    expect(h.has_security_token).toBe(true);
    expect(h.level).toBe('OK');
  });

  it('detects stale feed by age', () => {
    recordCapitalFeedTick(3, Date.now() - 20_000);
    expect(capitalFeedAgeMs(3)).toBeGreaterThan(15_000);
    expect(isCapitalFeedStale(3, 15_000)).toBe(true);
    const h = getCapitalSessionHealth(3);
    expect(h.code).toBe(DecisionCodes.WAIT_STALE_FEED);
  });

  it('records rate-limit cooldown on health', () => {
    recordCapitalSessionError(9, 'cooldown', { rateLimitMs: 60_000 });
    const h = getCapitalSessionHealth(9);
    expect(h.level).toBe('WARNING');
    expect(h.code).toBe(DecisionCodes.RATE_LIMITED);
    expect(h.rate_limited_until).toBeTruthy();
  });
});

// silence unused vi in case
void vi;
