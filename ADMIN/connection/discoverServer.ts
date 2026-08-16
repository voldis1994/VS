/**
 * ADMIN endpoint discovery — LAN first, WireGuard only as explicit fallback.
 *
 * Priority:
 * 1. Reach VS-CORE-01 on trusted home LAN
 * 2. Authenticated ADMIN uses that LAN URL
 * 3. WireGuard (10.77.0.1) only when LAN unavailable AND an ADMIN WG profile is configured
 *
 * Remote CLIENTS remain WireGuard-based; this module is for ADMIN only.
 */

export type Transport = 'lan' | 'wireguard';

export type DiscoverResult = {
  baseUrl: string;
  server_id: string | null;
  via: Transport;
};

export type DiscoverOptions = {
  expectedServerId?: string;
  /** Extra LAN candidates (saved config, env) — WireGuard URLs here are ignored for LAN pass */
  lanCandidates?: string[];
  /** Allow probing WireGuard private API */
  allowWireGuard?: boolean;
  /** Explicit WG URL candidates (only used when allowWireGuard) */
  wireguardCandidates?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Known / observed home-LAN endpoints for VS-CORE-01 (not a permanent hard bind). */
export const KNOWN_LAN_CANDIDATES = [
  'http://192.168.0.10:3000',
  'http://192.168.0.53:3000',
  'http://192.168.1.10:3000',
];

export const WIREGUARD_ADMIN_API = 'http://10.77.0.1:3000';

export function normalizeBase(url: string): string {
  return url.replace(/\/$/, '');
}

export function isWireGuardUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(normalizeBase(url));
    return u.hostname === '10.77.0.1' || u.hostname.startsWith('10.77.');
  } catch {
    return /10\.77\.0\.1/.test(url);
  }
}

function pushUnique(out: string[], u: string | undefined | null): void {
  if (!u) return;
  const n = normalizeBase(u.trim());
  if (n && !out.includes(n)) out.push(n);
}

function buildLanCandidates(extra?: string[]): string[] {
  const out: string[] = [];
  for (const e of extra || []) {
    if (!isWireGuardUrl(e)) pushUnique(out, e);
  }
  pushUnique(out, process.env.VS_LAN_SERVER_URL);
  // VS_SERVER_URL only if it is LAN (ignore stale WG URL during LAN pass)
  if (process.env.VS_SERVER_URL && !isWireGuardUrl(process.env.VS_SERVER_URL)) {
    pushUnique(out, process.env.VS_SERVER_URL);
  }
  for (const c of KNOWN_LAN_CANDIDATES) pushUnique(out, c);
  return out;
}

function buildWgCandidates(extra?: string[]): string[] {
  const out: string[] = [];
  for (const e of extra || []) {
    if (isWireGuardUrl(e)) pushUnique(out, e);
  }
  if (process.env.VS_SERVER_URL && isWireGuardUrl(process.env.VS_SERVER_URL)) {
    pushUnique(out, process.env.VS_SERVER_URL);
  }
  pushUnique(out, WIREGUARD_ADMIN_API);
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

async function probeList(
  candidates: string[],
  via: Transport,
  expected: string,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<DiscoverResult | null> {
  let fallback: DiscoverResult | null = null;
  for (const base of candidates) {
    const r = await probeHealth(base, timeoutMs, fetchImpl);
    if (!r.ok) continue;
    const hit: DiscoverResult = { baseUrl: base, server_id: r.server_id, via };
    if (r.server_id === expected) return hit;
    if (!fallback) fallback = hit;
  }
  return fallback;
}

/**
 * Discover ADMIN → VS-CORE-01 endpoint.
 * LAN always wins when reachable. WireGuard is never required for home-LAN ADMIN.
 */
export async function discoverVsServer(opts: DiscoverOptions = {}): Promise<DiscoverResult | null> {
  const expected = opts.expectedServerId || 'VS-CORE-01';
  const timeoutMs = opts.timeoutMs ?? 2500;
  const fetchImpl = opts.fetchImpl || fetch;

  const lanHit = await probeList(
    buildLanCandidates(opts.lanCandidates),
    'lan',
    expected,
    timeoutMs,
    fetchImpl
  );
  if (lanHit) return lanHit;

  if (!opts.allowWireGuard) {
    return null;
  }

  return probeList(
    buildWgCandidates(opts.wireguardCandidates),
    'wireguard',
    expected,
    timeoutMs,
    fetchImpl
  );
}

/** @deprecated Use lanCandidates — kept for older call sites that passed `candidates`. */
export async function discoverVsServerLegacyCompat(
  opts: DiscoverOptions & { candidates?: string[] } = {}
): Promise<DiscoverResult | null> {
  const { candidates, ...rest } = opts;
  return discoverVsServer({
    ...rest,
    lanCandidates: candidates,
  });
}
