/**
 * discoverServer unit tests — no real network; inject fetch.
 */
import { describe, it, expect, vi } from 'vitest';
import { discoverVsServer } from './discoverServer.js';

describe('discoverVsServer', () => {
  it('returns matching VS-CORE-01 candidate', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('192.168.0.99')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (u.endsWith('/health')) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
      }
      if (u.includes('/catalog')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, server_id: 'VS-CORE-01' }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const hit = await discoverVsServer({
      expectedServerId: 'VS-CORE-01',
      candidates: ['http://192.168.0.99:3000', 'http://192.168.0.10:3000'],
      timeoutMs: 500,
      fetchImpl,
    });
    expect(hit).not.toBeNull();
    expect(hit!.baseUrl).toBe('http://192.168.0.10:3000');
    expect(hit!.server_id).toBe('VS-CORE-01');
  });

  it('returns null when nothing responds', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const hit = await discoverVsServer({
      candidates: ['http://127.0.0.1:9'],
      timeoutMs: 200,
      fetchImpl,
    });
    expect(hit).toBeNull();
  });
});
