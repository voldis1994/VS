/**
 * LAN / private-network discovery for VS-CORE-01.
 * End users never type :3000 — Connection Manager / INSTALL resolves it.
 */

export type DiscoverResult = {
  baseUrl: string;
  server_id: string | null;
  via: string;
};

export type DiscoverOptions = {
  expectedServerId?: string;
  candidates?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_CANDIDATES = [
  'http://192.168.0.10:3000', // verified home LAN for VS-CORE-01
  'http://192.168.0.53:3000',
  'http://192.168.1.10:3000',
  'http://10.77.0.1:3000', // WireGuard private API
];

function normalizeBase(url: string): string {
  return url.replace(/\/$/, '');
}

function candidateList(extra?: string[]): string[] {
  const out: string[] = [];
  const push = (u: string | undefined) => {
    if (!u) return;
    const n = normalizeBase(u.trim());
    if (n && !out.includes(n)) out.push(n);
  };
  for (const e of extra || []) push(e);
  push(process.env.VS_SERVER_URL);
  push(process.env.VS_LAN_SERVER_URL);
  for (const c of DEFAULT_CANDIDATES) push(c);
  return out;
}

async function probeHealth(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<{ ok: boolean; server_id: string | null }> {
  try {
    const health = await fetchImpl(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!health.ok) return { ok: false, server_id: null };

    let server_id: string | null = null;
    try {
      const cat = await fetchImpl(`${baseUrl}/api/v1/network/catalog`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (cat.ok) {
        const body = (await cat.json()) as { server_id?: string };
        server_id = body.server_id || null;
      }
    } catch {
      /* catalog optional for reachability */
    }
    return { ok: true, server_id };
  } catch {
    return { ok: false, server_id: null };
  }
}

/**
 * Probe known LAN / WG candidates until VS server responds.
 * Prefer matches for expectedServerId (default VS-CORE-01).
 */
export async function discoverVsServer(opts: DiscoverOptions = {}): Promise<DiscoverResult | null> {
  const expected = opts.expectedServerId || 'VS-CORE-01';
  const timeoutMs = opts.timeoutMs ?? 2500;
  const fetchImpl = opts.fetchImpl || fetch;
  const candidates = candidateList(opts.candidates);

  let fallback: DiscoverResult | null = null;

  for (const base of candidates) {
    const r = await probeHealth(base, timeoutMs, fetchImpl);
    if (!r.ok) continue;
    const hit: DiscoverResult = {
      baseUrl: base,
      server_id: r.server_id,
      via: base.includes('10.77.0.1') ? 'wireguard' : 'lan',
    };
    if (r.server_id === expected) return hit;
    if (!fallback) fallback = hit;
  }
  return fallback;
}
