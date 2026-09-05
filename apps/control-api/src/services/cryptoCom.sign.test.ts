import { describe, expect, it } from 'vitest';
import { paramsToString, sanitizeCryptoComSecret, signRequest } from './cryptoCom.js';

describe('cryptoCom signing', () => {
  it('matches Crypto.com documented HMAC vector (public/auth)', () => {
    // From Exchange API docs Java/Python sample:
    // method=public/auth id=11 api_key=token nonce=1589594102779 secret=secretKey
    const sig = signRequest({
      method: 'public/auth',
      id: 11,
      apiKey: 'token',
      params: {},
      nonce: 1589594102779,
      apiSecret: 'secretKey',
    });
    expect(sig).toBe('9dcebf6eeec155f829227ee447dee73120e0aead42fab74d38ed5d8271793dc8');
  });

  it('sorts nested params deterministically', () => {
    const a = signRequest({
      method: 'private/create-order',
      id: 2,
      apiKey: 'k',
      params: { side: 'BUY', quantity: '1', instrument_name: 'BTC_USDT' },
      nonce: 1,
      apiSecret: 's',
    });
    const b = signRequest({
      method: 'private/create-order',
      id: 2,
      apiKey: 'k',
      params: { instrument_name: 'BTC_USDT', quantity: '1', side: 'BUY' },
      nonce: 1,
      apiSecret: 's',
    });
    expect(a).toBe(b);
  });

  it('paramsToString treats empty object as empty string', () => {
    expect(paramsToString({})).toBe('');
    expect(paramsToString(null)).toBe('null');
  });

  it('sanitizeCryptoComSecret strips BOM and zero-width chars', () => {
    expect(sanitizeCryptoComSecret('\uFEFFabc\u200Bdef\n')).toBe('abcdef');
  });
});
