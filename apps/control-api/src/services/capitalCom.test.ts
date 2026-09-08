import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capitalComBaseUrl,
  capitalEquityFromAccountFields,
  capitalRestTimeoutMs,
  encryptCapitalPassword,
  openCapitalSession,
  resolveEpicViaSearch,
  testCapitalComSession,
} from './capitalCom.js';
import { generateKeyPairSync } from 'crypto';
import { masterCapitalConnectionId } from '../master/capitalFactory.js';

describe('capitalRestTimeoutMs', () => {
  afterEach(() => {
    delete process.env.CAPITAL_REST_TIMEOUT_MS;
  });

  it('defaults to 12s and clamps env override', () => {
    expect(capitalRestTimeoutMs()).toBe(12_000);
    process.env.CAPITAL_REST_TIMEOUT_MS = '500';
    expect(capitalRestTimeoutMs()).toBe(500);
    process.env.CAPITAL_REST_TIMEOUT_MS = '50';
    expect(capitalRestTimeoutMs()).toBe(12_000);
  });
});

describe('Capital session REST abort timeout', () => {
  afterEach(() => {
    delete process.env.CAPITAL_REST_TIMEOUT_MS;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('request path returns capital_rest_timeout when fetch hangs', async () => {
    process.env.CAPITAL_REST_TIMEOUT_MS = '300';
    const headers = (h: Record<string, string>) => ({
      get: (k: string) => h[k] || h[k.toLowerCase()] || null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/encryptionKey')) {
          return {
            ok: false,
            status: 404,
            headers: headers({}),
            text: async () => '',
          };
        }
        if (u.includes('/api/v1/session') && (init?.method || 'GET') === 'POST') {
          return {
            ok: true,
            status: 200,
            headers: headers({
              CST: 'cst-t',
              'X-SECURITY-TOKEN': 'sec-t',
            }),
            text: async () =>
              JSON.stringify({ currentAccountId: 'acc-1', accountType: 'CFD' }),
          };
        }
        // Hang until AbortSignal fires
        await new Promise((_, reject) => {
          const s = init?.signal;
          if (!s) return;
          if (s.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          s.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
          });
        });
        return {
          ok: false,
          status: 0,
          headers: headers({}),
          text: async () => '',
        };
      })
    );

    const opened = await openCapitalSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'i',
      password: 'p',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const res = await opened.session.get('/api/v1/accounts');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.text).toBe('capital_rest_timeout');
  });
});

describe('confirmCapitalDeal DELETED close status', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('DELETED is closed_gone (not open accept, not rejected)', async () => {
    const { confirmCapitalDeal } = await import('./capitalCom.js');
    const session = {
      get: async () => ({
        ok: true,
        status: 200,
        json: {
          dealId: 'd-gone',
          status: 'DELETED',
          level: 4410.5,
          profit: -3.25,
        },
        text: '',
      }),
    } as any;
    const conf = await confirmCapitalDeal(session, 'ref-del');
    expect(conf.ok).toBe(false);
    expect(conf.rejected).toBeFalsy();
    expect(conf.closed_gone).toBe(true);
    expect(conf.deal_id).toBe('d-gone');
    expect(conf.profit).toBe(-3.25);
  });
});

describe('capitalEquityFromAccountFields', () => {
  it('includes floating profitLoss so underwater equity is below cash balance', () => {
    const r = capitalEquityFromAccountFields({
      balance: 10_000,
      available: 8_000,
      profitLoss: -1_500,
    });
    expect(r.balance).toBe(10_000);
    expect(r.equity).toBe(8_500);
  });

  it('prefers explicit equity when present', () => {
    const r = capitalEquityFromAccountFields({
      balance: 10_000,
      profitLoss: -500,
      equity: 9_200,
    });
    expect(r.equity).toBe(9_200);
  });
});

describe('fetchCapitalAccountEquity preferred CFD', () => {
  it('returns null when preferred accountId is missing (never richest sibling)', async () => {
    const { fetchCapitalAccountEquity } = await import('./capitalCom.js');
    const session = {
      currentAccountId: 'missing-cfd',
      preferredAccountId: 'missing-cfd',
      get: async () => ({
        ok: true,
        status: 200,
        json: {
          accounts: [
            {
              accountId: 'rich-sibling',
              accountType: 'CFD',
              balance: { balance: 50_000, available: 50_000, profitLoss: 0 },
              currency: 'GBP',
            },
            {
              accountId: 'small',
              accountType: 'CFD',
              balance: { balance: 1_000, available: 1_000, profitLoss: 0 },
              currency: 'GBP',
            },
          ],
        },
        text: '',
      }),
    } as any;
    const eq = await fetchCapitalAccountEquity(session, 'missing-cfd');
    expect(eq).toBeNull();
  });

  it('returns null when no preferred and no session.currentAccountId', async () => {
    const { fetchCapitalAccountEquity } = await import('./capitalCom.js');
    const session = {
      currentAccountId: '',
      get: async () => ({
        ok: true,
        status: 200,
        json: {
          accounts: [
            {
              accountId: 'rich-sibling',
              accountType: 'CFD',
              balance: { balance: 50_000, available: 50_000, profitLoss: 0 },
              currency: 'GBP',
            },
          ],
        },
        text: '',
      }),
    } as any;
    const eq = await fetchCapitalAccountEquity(session, null);
    expect(eq).toBeNull();
  });

  it('uses preferred account when present', async () => {
    const { fetchCapitalAccountEquity } = await import('./capitalCom.js');
    const session = {
      currentAccountId: 'pref',
      preferredAccountId: 'pref',
      get: async () => ({
        ok: true,
        status: 200,
        json: {
          accounts: [
            {
              accountId: 'rich-sibling',
              accountType: 'CFD',
              balance: { balance: 50_000, available: 50_000, profitLoss: 0 },
              currency: 'GBP',
            },
            {
              accountId: 'pref',
              accountType: 'CFD',
              balance: { balance: 2_000, available: 1_800, profitLoss: -50 },
              currency: 'GBP',
            },
          ],
        },
        text: '',
      }),
    } as any;
    const eq = await fetchCapitalAccountEquity(session, 'pref');
    expect(eq).not.toBeNull();
    expect(eq!.equity).toBe(1_950);
    expect(eq!.detail).toMatch(/account=pref/);
  });
});

describe('capitalComBaseUrl', () => {
  it('uses live host for live', () => {
    expect(capitalComBaseUrl('live')).toBe('https://api-capital.backend-capital.com');
  });

  it('defaults to demo host otherwise', () => {
    expect(capitalComBaseUrl('demo')).toBe('https://demo-api-capital.backend-capital.com');
    expect(capitalComBaseUrl('other')).toBe('https://demo-api-capital.backend-capital.com');
  });
});

describe('testCapitalComSession validation', () => {
  it('rejects email used as API key without calling network', async () => {
    const result = await testCapitalComSession({
      environment: 'live',
      apiKey: 'user@inbox.lv',
      identifier: 'user@inbox.lv',
      password: 'secret',
    });
    expect(result.ok).toBe(false);
    expect(result.detail.toLowerCase()).toContain('email');
  });

  it('rejects 6-digit OTP pasted as API password', async () => {
    const result = await testCapitalComSession({
      environment: 'live',
      apiKey: 'real-api-key-string',
      identifier: 'user@inbox.lv',
      password: '123456',
    });
    expect(result.ok).toBe(false);
    expect(result.detail.toLowerCase()).toContain('2fa');
  });
});

describe('encryptCapitalPassword', () => {
  it('produces base64 ciphertext with RSA public key', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const out = encryptCapitalPassword(der, 1710000000, 'api-password');
    expect(out.length).toBeGreaterThan(20);
    expect(() => Buffer.from(out, 'base64')).not.toThrow();
  });
});

describe('Capital session 401 re-login', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-POSTs /session once after 401 then retries the request', async () => {
    let sessionPosts = 0;
    let positionsGets = 0;
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || 'GET').toUpperCase();
        if (url.includes('/session/encryptionKey')) {
          return new Response('{}', { status: 404 });
        }
        if (url.endsWith('/api/v1/session') && method === 'POST') {
          sessionPosts += 1;
          const headers = new Headers({
            CST: `cst-${sessionPosts}`,
            'X-SECURITY-TOKEN': `sec-${sessionPosts}`,
          });
          return new Response(JSON.stringify({ accountId: 'a1' }), {
            status: 200,
            headers,
          });
        }
        // Preferred CFD re-pin after re-login (login-default is preferred)
        if (url.endsWith('/api/v1/session') && method === 'PUT') {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (url.includes('/positions') && method === 'GET') {
          positionsGets += 1;
          if (positionsGets === 1) {
            return new Response('{"errorCode":"error.invalid.session"}', {
              status: 401,
            });
          }
          return new Response(JSON.stringify({ positions: [] }), { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
      }
    );

    const opened = await openCapitalSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'user@example.com',
      password: 'api-pass-not-otp',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const listed = await opened.session.get('/api/v1/positions');
    expect(listed.ok).toBe(true);
    expect(listed.status).toBe(200);
    expect(sessionPosts).toBe(2); // initial + re-login
    expect(positionsGets).toBe(2); // 401 then retry
    expect(opened.session.cst).toBe('cst-2');
    // Login-default CFD is preferred so later 401s re-pin the same account
    expect(opened.session.preferredAccountId).toBe('a1');
  });

  it('re-pins preferred CFD account after 401 re-login (clears stale currentAccountId)', async () => {
    let sessionPosts = 0;
    let sessionPuts = 0;
    let lastPutBody: string | null = null;
    let positionsGets = 0;
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || 'GET').toUpperCase();
        if (url.includes('/session/encryptionKey')) {
          return new Response('{}', { status: 404 });
        }
        if (url.endsWith('/api/v1/session') && method === 'POST') {
          sessionPosts += 1;
          const headers = new Headers({
            CST: `cst-${sessionPosts}`,
            'X-SECURITY-TOKEN': `sec-${sessionPosts}`,
          });
          // Fresh login always lands on default CFD "default-cfd"
          return new Response(JSON.stringify({ accountId: 'default-cfd' }), {
            status: 200,
            headers,
          });
        }
        if (url.endsWith('/api/v1/session') && method === 'PUT') {
          sessionPuts += 1;
          lastPutBody = typeof init?.body === 'string' ? init.body : null;
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (url.includes('/positions') && method === 'GET') {
          positionsGets += 1;
          if (positionsGets === 1) {
            return new Response('{"errorCode":"error.invalid.session"}', {
              status: 401,
            });
          }
          return new Response(JSON.stringify({ positions: [] }), { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
      }
    );

    const opened = await openCapitalSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'user@example.com',
      password: 'api-pass-not-otp',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // Simulate prior pin (stale after CST death) — without clear, switch would skip PUT
    opened.session.currentAccountId = 'preferred-cfd';
    opened.session.preferredAccountId = 'preferred-cfd';
    const listed = await opened.session.get('/api/v1/positions');
    expect(listed.ok).toBe(true);
    expect(sessionPosts).toBe(2);
    expect(sessionPuts).toBe(1);
    expect(lastPutBody).toContain('preferred-cfd');
    expect(opened.session.currentAccountId).toBe('preferred-cfd');
    expect(opened.session.cst).toBe('cst-2');
  });

  it('does not retry mutate when preferred CFD re-pin fails after 401', async () => {
    let sessionPosts = 0;
    let positionsGets = 0;
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || 'GET').toUpperCase();
        if (url.includes('/session/encryptionKey')) {
          return new Response('{}', { status: 404 });
        }
        if (url.endsWith('/api/v1/session') && method === 'POST') {
          sessionPosts += 1;
          const headers = new Headers({
            CST: `cst-${sessionPosts}`,
            'X-SECURITY-TOKEN': `sec-${sessionPosts}`,
          });
          return new Response(JSON.stringify({ accountId: 'default-cfd' }), {
            status: 200,
            headers,
          });
        }
        if (url.endsWith('/api/v1/session') && method === 'PUT') {
          return new Response(
            JSON.stringify({ errorCode: 'error.account.unavailable' }),
            { status: 400 }
          );
        }
        if (url.includes('/positions') && method === 'GET') {
          positionsGets += 1;
          if (positionsGets === 1) {
            return new Response('{"errorCode":"error.invalid.session"}', {
              status: 401,
            });
          }
          // Must not be reached — failed pin aborts retry
          return new Response(JSON.stringify({ positions: [] }), { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
      }
    );

    const opened = await openCapitalSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'user@example.com',
      password: 'api-pass-not-otp',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.session.preferredAccountId = 'preferred-cfd';
    const listed = await opened.session.get('/api/v1/positions');
    expect(listed.ok).toBe(false);
    expect(listed.status).toBe(401);
    expect(positionsGets).toBe(1); // no retry on wrong CFD
    expect(opened.session.currentAccountId).toBeNull();
  });
});

describe('Capital session pool identity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MASTER_CAPITAL_CONNECTION_ID;
  });

  it('acquireCapitalSession returns same object as raw (no shallow-copy fork)', async () => {
    const { acquireCapitalSession, invalidateCapitalSession } = await import(
      './capitalCom.js'
    );
    let sessionPosts = 0;
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || 'GET').toUpperCase();
        if (url.includes('/session/encryptionKey')) {
          return new Response('{}', { status: 404 });
        }
        if (url.endsWith('/api/v1/session') && method === 'POST') {
          sessionPosts += 1;
          const headers = new Headers({
            CST: `cst-pool-${sessionPosts}`,
            'X-SECURITY-TOKEN': `sec-pool-${sessionPosts}`,
          });
          return new Response(JSON.stringify({ accountId: 'a-default' }), {
            status: 200,
            headers,
          });
        }
        if (url.endsWith('/api/v1/session') && method === 'PUT') {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }
    );

    const a = await acquireCapitalSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'user@example.com',
      password: 'api-pass-not-otp',
      connectionId: 900099,
      capitalAccountId: 'cfd-B',
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    a.session.currentAccountId = 'mutated-on-session';
    const b = await acquireCapitalSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'user@example.com',
      password: 'api-pass-not-otp',
      connectionId: 900099,
      capitalAccountId: 'cfd-B',
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    // Same identity — mutation visible on re-acquire (pool cache)
    expect(b.session).toBe(a.session);
    expect(b.session.currentAccountId).toBe('cfd-B'); // switch re-applied
    expect(b.session.preferredAccountId).toBe('cfd-B');
    expect(sessionPosts).toBe(1); // cached, no second login
    invalidateCapitalSession(900099);
  });

  it('testCapitalComSession reuses pool and never DELETE/closes (keeps MASTER CST)', async () => {
    const { acquireCapitalSession, invalidateCapitalSession } = await import(
      './capitalCom.js'
    );
    let sessionPosts = 0;
    let sessionDeletes = 0;
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || 'GET').toUpperCase();
        if (url.includes('/session/encryptionKey')) {
          return new Response('{}', { status: 404 });
        }
        if (url.endsWith('/api/v1/session') && method === 'POST') {
          sessionPosts += 1;
          const headers = new Headers({
            CST: `cst-test-${sessionPosts}`,
            'X-SECURITY-TOKEN': `sec-test-${sessionPosts}`,
          });
          return new Response(JSON.stringify({ accountId: 'a1', accountType: 'CFD' }), {
            status: 200,
            headers,
          });
        }
        if (url.endsWith('/api/v1/session') && method === 'DELETE') {
          sessionDeletes += 1;
          return new Response('{}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }
    );
    const r = await testCapitalComSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'user@example.com',
      password: 'api-pass-not-otp',
      connectionId: 900088,
    });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/pool=900088/);
    expect(sessionPosts).toBe(1);
    expect(sessionDeletes).toBe(0);
    // Re-acquire must hit cache (probe/test left pool warm)
    const again = await acquireCapitalSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'user@example.com',
      password: 'api-pass-not-otp',
      connectionId: 900088,
    });
    expect(again.ok).toBe(true);
    expect(sessionPosts).toBe(1);
    invalidateCapitalSession(900088);
  });

  it('soft TTL ping reuses same CST object (no DELETE while broker holds it)', async () => {
    const { acquireCapitalSession, invalidateCapitalSession } = await import(
      './capitalCom.js'
    );
    process.env.MASTER_CAPITAL_POOL_TTL_MS = '40';
    let sessionPosts = 0;
    let sessionDeletes = 0;
    let sessionGets = 0;
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || 'GET').toUpperCase();
        if (url.includes('/session/encryptionKey')) {
          return new Response('{}', { status: 404 });
        }
        if (url.endsWith('/api/v1/session') && method === 'POST') {
          sessionPosts += 1;
          const headers = new Headers({
            CST: `cst-ttl-${sessionPosts}`,
            'X-SECURITY-TOKEN': `sec-ttl-${sessionPosts}`,
          });
          return new Response(JSON.stringify({ accountId: 'a1' }), {
            status: 200,
            headers,
          });
        }
        if (url.endsWith('/api/v1/session') && method === 'GET') {
          sessionGets += 1;
          return new Response(JSON.stringify({ accountId: 'a1' }), { status: 200 });
        }
        if (url.endsWith('/api/v1/session') && method === 'DELETE') {
          sessionDeletes += 1;
          return new Response('{}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }
    );
    const a = await acquireCapitalSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'user@example.com',
      password: 'api-pass-not-otp',
      connectionId: 900077,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await new Promise((r) => setTimeout(r, 55)); // past soft TTL
    const b = await acquireCapitalSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'user@example.com',
      password: 'api-pass-not-otp',
      connectionId: 900077,
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.session).toBe(a.session); // same object — CapitalBroker-safe
    expect(sessionPosts).toBe(1);
    expect(sessionGets).toBeGreaterThanOrEqual(1);
    expect(sessionDeletes).toBe(0);
    invalidateCapitalSession(900077);
    delete process.env.MASTER_CAPITAL_POOL_TTL_MS;
  });
});

describe('resolveEpicViaSearch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when best score is below 60 (no markets[0] fallback)', async () => {
    const session = {
      get: async () => ({
        ok: true,
        status: 200,
        json: {
          markets: [
            { epic: 'SILVER', instrumentName: 'Silver Spot' },
            { epic: 'OIL', instrumentName: 'US Crude' },
          ],
        },
        text: '',
      }),
    } as any;
    const epic = await resolveEpicViaSearch(session, 'PLATINUMXYZ');
    expect(epic).toBeNull();
  });

  it('returns gold epic when name matches', async () => {
    const session = {
      get: async () => ({
        ok: true,
        status: 200,
        json: {
          markets: [
            { epic: 'SILVER', instrumentName: 'Silver' },
            { epic: 'GOLD', instrumentName: 'Gold Spot' },
          ],
        },
        text: '',
      }),
    } as any;
    const epic = await resolveEpicViaSearch(session, 'gold');
    expect(epic).toBe('GOLD');
  });
});

describe('masterCapitalConnectionId', () => {
  afterEach(() => {
    delete process.env.MASTER_CAPITAL_CONNECTION_ID;
  });

  it('defaults to 900001 for env and desk (no CST fork)', () => {
    delete process.env.MASTER_CAPITAL_CONNECTION_ID;
    expect(masterCapitalConnectionId()).toBe(900001);
    expect(masterCapitalConnectionId(null)).toBe(900001);
    expect(masterCapitalConnectionId(0)).toBe(900001);
  });

  it('honors explicit id and env override', () => {
    expect(masterCapitalConnectionId(42)).toBe(42);
    process.env.MASTER_CAPITAL_CONNECTION_ID = '777';
    expect(masterCapitalConnectionId()).toBe(777);
    expect(masterCapitalConnectionId(42)).toBe(42); // explicit wins
  });
});

describe('resolveEpicViaSearch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses weak match instead of returning markets[0]', async () => {
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || 'GET').toUpperCase();
        if (url.includes('/session/encryptionKey')) {
          return new Response('{}', { status: 404 });
        }
        if (url.endsWith('/api/v1/session') && method === 'POST') {
          const headers = new Headers({
            CST: 'cst-1',
            'X-SECURITY-TOKEN': 'sec-1',
          });
          return new Response(JSON.stringify({ accountId: 'a1' }), {
            status: 200,
            headers,
          });
        }
        if (url.includes('/markets?searchTerm=')) {
          return new Response(
            JSON.stringify({
              markets: [
                { epic: 'COPPER', instrumentName: 'Copper' },
                { epic: 'NATURALGAS', instrumentName: 'Natural Gas' },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      }
    );
    const opened = await openCapitalSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'user@example.com',
      password: 'api-pass-not-otp',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const epic = await resolveEpicViaSearch(opened.session, 'GOLD');
    expect(epic).toBeNull();
  });

  it('returns high-score epic when name matches', async () => {
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || 'GET').toUpperCase();
        if (url.includes('/session/encryptionKey')) {
          return new Response('{}', { status: 404 });
        }
        if (url.endsWith('/api/v1/session') && method === 'POST') {
          const headers = new Headers({
            CST: 'cst-1',
            'X-SECURITY-TOKEN': 'sec-1',
          });
          return new Response(JSON.stringify({ accountId: 'a1' }), {
            status: 200,
            headers,
          });
        }
        if (url.includes('/markets?searchTerm=')) {
          return new Response(
            JSON.stringify({
              markets: [
                { epic: 'COPPER', instrumentName: 'Copper' },
                { epic: 'GOLD', instrumentName: 'Gold' },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      }
    );
    const opened = await openCapitalSession({
      environment: 'demo',
      apiKey: 'k',
      identifier: 'user@example.com',
      password: 'api-pass-not-otp',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const epic = await resolveEpicViaSearch(opened.session, 'GOLD');
    expect(epic).toBe('GOLD');
  });
});
