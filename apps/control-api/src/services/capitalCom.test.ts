import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateMinutesToFifteen,
  capitalComBaseUrl,
  capitalFetch,
  CAPITAL_HTTP_TIMEOUT_MS,
  capitalLeaseNestedLockSmokeTest,
  encryptCapitalPassword,
  lastClosedCapitalMinute,
  prevClosedCapitalMinute,
  testCapitalComSession,
} from './capitalCom.js';
import { generateKeyPairSync } from 'crypto';

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

describe('aggregateMinutesToFifteen', () => {
  it('packs sequential 1m bars into 15m OHLC', () => {
    const mins = [];
    for (let i = 0; i < 30; i++) {
      mins.push({
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100.5 + i,
        snapshot_time_ms: null as number | null,
      });
    }
    const m15 = aggregateMinutesToFifteen(mins);
    expect(m15.length).toBe(2);
    expect(m15[0]!.open).toBe(100);
    expect(m15[0]!.close).toBe(114.5);
    expect(m15[0]!.high).toBe(115);
    expect(m15[0]!.low).toBe(99);
  });
});

describe('prevClosedCapitalMinute', () => {
  it('returns the closed bar before lastClosed', () => {
    const now = 1_700_000_000_000;
    const candles = [
      { open: 1, high: 2, low: 0.5, close: 1.5, snapshot_time_ms: now - 180_000 },
      { open: 1.5, high: 3, low: 1.4, close: 2.8, snapshot_time_ms: now - 120_000 },
      { open: 2.8, high: 3.1, low: 2.5, close: 2.6, snapshot_time_ms: now - 60_000 },
      { open: 2.6, high: 2.7, low: 2.5, close: 2.55, snapshot_time_ms: now }, // forming
    ];
    expect(lastClosedCapitalMinute(candles, now)!.close).toBe(2.6);
    expect(prevClosedCapitalMinute(candles, now)!.close).toBe(2.8);
  });
});

describe('Capital lease nested lock (no quote freeze)', () => {
  it('nested connection lock re-enters while lease ALS is held', async () => {
    await expect(capitalLeaseNestedLockSmokeTest(9_101_001)).resolves.toBe('ok');
  });
});

describe('capitalFetch timeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('exports 15s default timeout', () => {
    expect(CAPITAL_HTTP_TIMEOUT_MS).toBe(15_000);
  });

  it('aborts hung HTTP and throws timeout error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      })
    );
    await expect(capitalFetch('https://example.test/hang', {}, 50)).rejects.toThrow(
      /Capital\.com HTTP timeout after 50ms/
    );
  });
});
