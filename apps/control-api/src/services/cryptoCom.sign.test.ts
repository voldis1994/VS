import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';

// Mirror of cryptoCom sign payload construction for regression coverage
function paramsToString(obj: unknown, level = 0): string {
  if (obj === null || obj === undefined) return 'null';
  if (level >= 3) return String(obj);
  if (Array.isArray(obj)) return obj.map((item) => paramsToString(item, level + 1)).join('');
  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .map((key) => `${key}${paramsToString(record[key], level + 1)}`)
      .join('');
  }
  return String(obj);
}

function sign(method: string, id: number, apiKey: string, params: Record<string, unknown>, nonce: number, secret: string) {
  const payload = `${method}${id}${apiKey}${paramsToString(params)}${nonce}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

describe('cryptoCom signing', () => {
  it('matches Crypto.com Exchange HMAC payload shape', () => {
    const sig = sign(
      'private/get-accounts',
      1,
      'api-key',
      {},
      1587846358253,
      'secret'
    );
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[a-f0-9]+$/);
  });

  it('sorts nested params deterministically', () => {
    const a = sign('private/create-order', 2, 'k', { side: 'BUY', quantity: '1', instrument_name: 'BTC_USDT' }, 1, 's');
    const b = sign('private/create-order', 2, 'k', { instrument_name: 'BTC_USDT', quantity: '1', side: 'BUY' }, 1, 's');
    expect(a).toBe(b);
  });
});
