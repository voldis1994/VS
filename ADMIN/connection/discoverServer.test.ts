/**
 * discoverServer — LAN-first; WireGuard only when allowed and LAN down.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  discoverVsServer,
  isWireGuardUrl,
  WIREGUARD_ADMIN_API,
} from './discoverServer.js';

function mockFetch(map: Record<string, { health?: boolean; server_id?: string }>) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    const base = u.replace(/\/health$/, '').replace(/\/api\/v1\/network\/catalog$/, '');
    const entry = map[base];
    if (!entry || entry.health === false) {
      throw new Error('unreachable');
    }
    if (u.endsWith('/health')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    }
    if (u.includes('/catalog')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, server_id: entry.server_id || 'VS-CORE-01' }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

describe('isWireGuardUrl', () => {
  it('detects private WG API host', () => {
    expect(isWireGuardUrl('http://10.77.0.1:3000')).toBe(true);
    expect(isWireGuardUrl('http://192.168.0.10:3000')).toBe(false);
  });
});

describe('discoverVsServer', () => {
  it('prefers LAN over WireGuard when both respond', async () => {
    const fetchImpl = mockFetch({
      'http://192.168.0.10:3000': { health: true, server_id: 'VS-CORE-01' },
      [WIREGUARD_ADMIN_API]: { health: true, server_id: 'VS-CORE-01' },
    });
    const hit = await discoverVsServer({
      allowWireGuard: true,
      wireguardCandidates: [WIREGUARD_ADMIN_API],
      timeoutMs: 500,
      fetchImpl,
    });
    expect(hit).not.toBeNull();
    expect(hit!.via).toBe('lan');
    expect(hit!.baseUrl).toBe('http://192.168.0.10:3000');
  });

  it('succeeds on LAN even when WireGuard is down and not required', async () => {
    const fetchImpl = mockFetch({
      'http://192.168.0.10:3000': { health: true, server_id: 'VS-CORE-01' },
    });
    const hit = await discoverVsServer({
      allowWireGuard: false,
      lanCandidates: ['http://10.77.0.1:3000', 'http://192.168.0.10:3000'], // WG URL ignored in LAN pass
      timeoutMs: 500,
      fetchImpl,
    });
    expect(hit).not.toBeNull();
    expect(hit!.via).toBe('lan');
    expect(hit!.baseUrl).toBe('http://192.168.0.10:3000');
  });

  it('does not fall back to WireGuard unless allowWireGuard', async () => {
    const fetchImpl = mockFetch({
      [WIREGUARD_ADMIN_API]: { health: true, server_id: 'VS-CORE-01' },
    });
    const hit = await discoverVsServer({
      allowWireGuard: false,
      lanCandidates: ['http://192.168.0.99:3000'],
      timeoutMs: 500,
      fetchImpl,
    });
    expect(hit).toBeNull();
  });

  it('uses WireGuard only when LAN fails and allowWireGuard', async () => {
    const fetchImpl = mockFetch({
      [WIREGUARD_ADMIN_API]: { health: true, server_id: 'VS-CORE-01' },
    });
    const hit = await discoverVsServer({
      allowWireGuard: true,
      lanCandidates: ['http://192.168.0.99:3000'],
      wireguardCandidates: [WIREGUARD_ADMIN_API],
      timeoutMs: 500,
      fetchImpl,
    });
    expect(hit).not.toBeNull();
    expect(hit!.via).toBe('wireguard');
    expect(hit!.baseUrl).toBe(WIREGUARD_ADMIN_API);
  });

  it('returns null when nothing responds', async () => {
    const fetchImpl = mockFetch({});
    const hit = await discoverVsServer({
      lanCandidates: ['http://127.0.0.1:9'],
      timeoutMs: 200,
      fetchImpl,
    });
    expect(hit).toBeNull();
  });
});
