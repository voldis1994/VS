import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capitalComBaseUrl,
  encryptCapitalPassword,
  openCapitalSession,
  testCapitalComSession,
} from './capitalCom.js';
import { generateKeyPairSync } from 'crypto';
import { masterCapitalConnectionId } from '../master/capitalFactory.js';

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
