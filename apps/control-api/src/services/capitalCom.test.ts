import { describe, expect, it } from 'vitest';
import {
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
