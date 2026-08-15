import { describe, expect, it, vi } from 'vitest';
import {
  capitalComBaseUrl,
  confirmCapitalDeal,
  encryptCapitalPassword,
  testCapitalComSession,
  type CapitalSession,
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

describe('confirmCapitalDeal dealStatus', () => {
  function mockSession(json: Record<string, unknown>): CapitalSession {
    return {
      base: 'https://demo-api-capital.backend-capital.com',
      apiKey: 'k',
      cst: 'c',
      securityToken: 't',
      close: async () => {},
      get: vi.fn(async () => ({
        ok: true,
        status: 200,
        json,
        text: JSON.stringify(json),
      })),
      post: vi.fn(),
      put: vi.fn(),
      del: vi.fn(),
    } as unknown as CapitalSession;
  }

  it('rejects HTTP-OK confirm when dealStatus=REJECTED even if dealId present', async () => {
    const conf = await confirmCapitalDeal(
      mockSession({ dealStatus: 'REJECTED', dealId: 'd1', reason: 'ATTENTION' }),
      'ref-1'
    );
    expect(conf.ok).toBe(false);
    expect(conf.detail).toMatch(/REJECTED/);
  });

  it('accepts ACCEPTED confirm with dealId', async () => {
    const conf = await confirmCapitalDeal(
      mockSession({ dealStatus: 'ACCEPTED', dealId: 'd2' }),
      'ref-2'
    );
    expect(conf.ok).toBe(true);
    expect(conf.deal_id).toBe('d2');
  });
});
