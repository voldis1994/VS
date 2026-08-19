import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';
import {
  capitalComBaseUrl,
  confirmCapitalDeal,
  encryptCapitalPassword,
  testCapitalComSession,
  readCapitalMarketStatus,
  effectiveCapitalMarketStatus,
  utcMinutesInOpenWindows,
  isCapitalWeekendUtc,
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

describe('broker TEST login', () => {
  it('uses one pooled Capital session — TEST must not login then login again', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../routes/brokers.ts'), 'utf8');
    const start = src.indexOf("app.post('/api/brokers/:id/test'");
    const end = src.indexOf("app.delete('/api/brokers/:id'");
    const chunk = src.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(chunk).toContain('acquireCapitalSession');
    expect(chunk).not.toContain('testCapitalComSession');
    expect(chunk.match(/acquireCapitalSession/g)?.length).toBe(1);
  });

  it('PULL CAPITAL waits out Capital 429 cooldown instead of failing immediately', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../routes/trading.ts'), 'utf8');
    expect(src).toMatch(/waitForCooldown:\s*true/);
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

describe('Capital marketStatus + openingHours', () => {
  it('reads snapshot.marketStatus CLOSED', () => {
    const json = { snapshot: { marketStatus: 'CLOSED', bid: 4334.57, offer: 4334.87 } };
    expect(readCapitalMarketStatus(json)).toBe('CLOSED');
    expect(effectiveCapitalMarketStatus(json, new Date('2026-08-18T21:19:00Z'))).toBe('CLOSED');
  });

  it('reads nested { value } marketStatus', () => {
    expect(
      readCapitalMarketStatus({ instrument: { marketStatus: { value: 'offline' } } })
    ).toBe('OFFLINE');
  });

  it('forces CLOSED in the Gold daily break even if snapshot says TRADEABLE', () => {
    const now = new Date('2026-08-18T21:19:00Z');
    expect(
      utcMinutesInOpenWindows([{ openTime: '22:00', closeTime: '21:00' }], now)
    ).toBe(false);
    const json = {
      snapshot: { marketStatus: 'TRADEABLE', bid: 4334.57, offer: 4334.87 },
      instrument: {
        openingHours: { marketTimes: [{ openTime: '22:00', closeTime: '21:00' }] },
      },
    };
    expect(effectiveCapitalMarketStatus(json, now)).toBe('CLOSED');
  });

  it('keeps TRADEABLE inside wrapping midnight hours', () => {
    const json = {
      snapshot: { marketStatus: 'TRADEABLE' },
      instrument: {
        openingHours: { marketTimes: [{ openTime: '22:00', closeTime: '21:00' }] },
      },
    };
    expect(effectiveCapitalMarketStatus(json, new Date('2026-08-18T23:05:00Z'))).toBe('TRADEABLE');
  });

  it('treats stale CLOSED as TRADEABLE after the daily Gold reopen', () => {
    const json = {
      snapshot: { marketStatus: 'CLOSED', bid: 4342.15, offer: 4342.45 },
      instrument: {
        openingHours: { marketTimes: [{ openTime: '22:00', closeTime: '21:00' }] },
      },
    };
    expect(effectiveCapitalMarketStatus(json, new Date('2026-08-18T22:05:00Z'))).toBe('TRADEABLE');
    expect(effectiveCapitalMarketStatus(json, new Date('2026-08-18T20:05:00Z'))).toBe('TRADEABLE');
  });

  it('keeps CLOSED on the weekend even if clock time looks in-session', () => {
    expect(isCapitalWeekendUtc(new Date('2026-08-22T23:05:00Z'))).toBe(true);
    const json = {
      snapshot: { marketStatus: 'CLOSED', bid: 4342.15, offer: 4342.45 },
      instrument: {
        openingHours: { marketTimes: [{ openTime: '22:00', closeTime: '21:00' }] },
      },
    };
    expect(effectiveCapitalMarketStatus(json, new Date('2026-08-22T23:05:00Z'))).toBe('CLOSED');
  });

  it('keeps CLOSED in the daily break when snapshot is also CLOSED', () => {
    const json = {
      snapshot: { marketStatus: 'CLOSED', bid: 4342.15, offer: 4342.45 },
      instrument: {
        openingHours: { marketTimes: [{ openTime: '22:00', closeTime: '21:00' }] },
      },
    };
    expect(effectiveCapitalMarketStatus(json, new Date('2026-08-18T21:19:00Z'))).toBe('CLOSED');
  });

  it('unsticks CLOSED after reopen even when Capital omits openingHours', () => {
    const json = { snapshot: { marketStatus: 'CLOSED', bid: 4342.15, offer: 4342.45 } };
    expect(effectiveCapitalMarketStatus(json, new Date('2026-08-18T22:05:00Z'))).toBe('TRADEABLE');
    expect(effectiveCapitalMarketStatus(json, new Date('2026-08-18T21:19:00Z'))).toBe('CLOSED');
  });
});

describe('computeProfitLockStopLevel', () => {
  it('BUY locks 75% of MFE below mid', async () => {
    const { computeProfitLockStopLevel, PROFIT_LOCK_RATIO } = await import('./capitalCom.js');
    expect(PROFIT_LOCK_RATIO).toBe(0.75);
    const entry = 2490;
    const mfe = 6;
    const mid = 2496;
    const stop = computeProfitLockStopLevel('BUY', entry, mfe, mid, { minStopDistance: 0.5 });
    expect(stop).toBeCloseTo(2494.5, 1);
    expect(stop!).toBeGreaterThan(entry);
    expect(stop!).toBeLessThan(mid);
  });

  it('SELL locks 75% of MFE above mid', async () => {
    const { computeProfitLockStopLevel } = await import('./capitalCom.js');
    const entry = 2496;
    const mfe = 6;
    const mid = 2490;
    const stop = computeProfitLockStopLevel('SELL', entry, mfe, mid, { minStopDistance: 0.5 });
    expect(stop).toBeCloseTo(2491.5, 1);
    expect(stop!).toBeLessThan(entry);
    expect(stop!).toBeGreaterThan(mid);
  });

  it('BUY clamps lock when price retraces from peak MFE', async () => {
    const { computeProfitLockStopLevel } = await import('./capitalCom.js');
    const entry = 2490;
    const mfe = 6;
    const mid = 2493;
    const stop = computeProfitLockStopLevel('BUY', entry, mfe, mid, { minStopDistance: 0.5 });
    expect(stop).not.toBeNull();
    expect(stop!).toBeGreaterThan(entry);
    expect(stop!).toBeLessThan(mid);
    expect(stop!).toBeLessThanOrEqual(2492.4);
  });
});
