import { describe, expect, it } from 'vitest';
import { validateLotSize, assertNoSecrets } from '../services/clientPanel.js';
import { formatTradeLabel } from '../services/tradePresentation.js';
import { hashSessionToken, parseCookieHeader, clientCookieSecure } from './clientSession.js';

describe('client panel helpers', () => {
  it('maps trade labels honestly (BUY/SELL only without classification)', () => {
    expect(formatTradeLabel('BUY')).toBe('BUY');
    expect(formatTradeLabel('SELL')).toBe('SELL');
    expect(formatTradeLabel(null)).toBeNull();
    expect(formatTradeLabel('BUY', null, 'TREND_UP')).toBe('BUY LONG');
    expect(formatTradeLabel('SELL', null, 'BREAKOUT_DOWN')).toBe('SELL SCALP');
  });

  it('validates lot size against min/max/step', () => {
    expect(validateLotSize(0.1, 0.01, 10, 0.01)).toBeNull();
    expect(validateLotSize(0.02, 0.01, 10, 0.01)).toBeNull();
    expect(validateLotSize(0.005, 0.01, 10, 0.01)).toMatch(/below min/);
    expect(validateLotSize(20, 0.01, 10, 0.01)).toMatch(/above max/);
    expect(validateLotSize(0.014, 0.01, 10, 0.01)).toMatch(/lot_step/);
  });

  it('refuses payloads that contain credential fields', () => {
    expect(() => assertNoSecrets({ ok: true })).not.toThrow();
    expect(() => assertNoSecrets({ api_key: 'x' })).toThrow(/secret field/);
    expect(() => assertNoSecrets({ nested: { password: 'x' } })).toThrow(/secret field/);
    expect(() => assertNoSecrets({ access_code_hash: 'x' })).toThrow(/secret field/);
  });

  it('hashes session tokens stably', () => {
    const a = hashSessionToken('abc');
    const b = hashSessionToken('abc');
    const c = hashSessionToken('xyz');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });

  it('parses session cookie from header', () => {
    const token = parseCookieHeader('a=1; vs_client_session=tok123; b=2', 'vs_client_session');
    expect(token).toBe('tok123');
    expect(parseCookieHeader('a=1', 'vs_client_session')).toBeNull();
  });

  it('does not force Secure cookies just because NODE_ENV=production', () => {
    const prevNode = process.env.NODE_ENV;
    const prevSecure = process.env.CLIENT_COOKIE_SECURE;
    process.env.NODE_ENV = 'production';
    process.env.CLIENT_COOKIE_SECURE = 'false';
    expect(clientCookieSecure()).toBe(false);
    process.env.CLIENT_COOKIE_SECURE = 'true';
    expect(clientCookieSecure()).toBe(true);
    process.env.CLIENT_COOKIE_SECURE = prevSecure ?? '';
    process.env.NODE_ENV = prevNode;
  });
});
