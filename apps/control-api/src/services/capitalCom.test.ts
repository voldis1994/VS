import { describe, expect, it } from 'vitest';
import {
  aggregateMinutesToFifteen,
  capitalComBaseUrl,
  encryptCapitalPassword,
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
