/**
 * ADMIN endpoint discovery — LAN first, WireGuard only as explicit fallback.
 *
 * Priority:
 * 1. Saved / configured verified server address
 * 2. Extra LAN candidates (env, SERVER_IP)
 * 3. Known home-LAN candidates + controlled subnet probe (caller may pass)
 * 4. WireGuard only when allowWireGuard
 *
 * A random HTTP service on :3000 is NEVER accepted — /health must return
 * service=VS-CORE and a server_id.
 */

export type Transport = 'lan' | 'wireguard';

export type DiscoverResult = {
  baseUrl: string;
  server_id: string | null;
  via: Transport;
  service: 'VS-CORE';
  build_commit?: string | null;
  version?: string | null;
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

export type VsCoreIdentity = {
  ok: boolean;
  server_id: string | null;
  build_commit: string | null;
  version: string | null;
};

/**
 * Accept only hosts whose /health proves VS-CORE identity (non-secret fields).
 */
export async function probeVsCoreIdentity(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<VsCoreIdentity> {
  const fail: VsCoreIdentity = {
    ok: false,
    server_id: null,
    build_commit: null,
    version: null,
  };
  try {
    const health = await fetchImpl(`${normalizeBase(baseUrl)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!health.ok) return fail;
    const body = (await health.json()) as {
      service?: string;
      server_id?: string;
      build_commit?: string;
      git_sha?: string;
      version?: string;
      VERSION?: string;
      status?: string;
    };
    if (body.service !== 'VS-CORE') return fail;
    const server_id = typeof body.server_id === 'string' && body.server_id.trim() ? body.server_id.trim() : null;
    if (!server_id) return fail;
    return {
      ok: true,
      server_id,
      build_commit: body.build_commit || body.git_sha || null,
      version: body.version || body.VERSION || null,
    };
  } catch {
    return fail;
  }
}

async function probeList(
  candidates: string[],
  via: Transport,
  expected: string,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<DiscoverResult | null> {
  for (const base of candidates) {
    const r = await probeVsCoreIdentity(base, timeoutMs, fetchImpl);
    if (!r.ok || !r.server_id) continue;
    // Prefer exact server_id match; still accept other VS-CORE hosts on LAN
    // only when expected is wildcard-empty (never accept non-VS-CORE).
    if (expected && r.server_id !== expected) continue;
    return {
      baseUrl: normalizeBase(base),
      server_id: r.server_id,
      via,
      service: 'VS-CORE',
      build_commit: r.build_commit,
      version: r.version,
    };
  }
  return null;
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
