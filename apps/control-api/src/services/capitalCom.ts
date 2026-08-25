import { createPublicKey, publicEncrypt, constants } from 'crypto';

export type CapitalComEnv = 'demo' | 'live';

export function capitalComBaseUrl(environment: string): string {
  return environment === 'live'
    ? 'https://api-capital.backend-capital.com'
    : 'https://demo-api-capital.backend-capital.com';
}

export interface CapitalComSessionResult {
  ok: boolean;
  status: number;
  detail: string;
  errorCode?: string;
  accountType?: string;
}

export interface CapitalSession {
  base: string;
  apiKey: string;
  cst: string;
  securityToken: string;
  accountType?: string;
  currentAccountId?: string | null;
  close: () => Promise<void>;
  get: (path: string) => Promise<{ ok: boolean; status: number; json: any; text: string }>;
  post: (
    path: string,
    body?: unknown
  ) => Promise<{ ok: boolean; status: number; json: any; text: string }>;
  put: (
    path: string,
    body?: unknown
  ) => Promise<{ ok: boolean; status: number; json: any; text: string }>;
  del: (path: string) => Promise<{ ok: boolean; status: number; json: any; text: string }>;
}

export interface CapitalMarket {
  epic: string;
  symbol: string;
  display_name: string;
  instrument_type: string;
  category: string;
  min_lot: number;
  max_lot: number;
  lot_step: number;
}

/** RSA encrypt password|timestamp per Capital.com session docs. */
export function encryptCapitalPassword(
  encryptionKeyBase64: string,
  timeStamp: number | string,
  password: string
): string {
  const mixed = Buffer.from(`${password}|${timeStamp}`, 'utf8').toString('base64');
  const key = createPublicKey({
    key: Buffer.from(encryptionKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const encrypted = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(mixed, 'utf8')
  );
  return encrypted.toString('base64');
}

function explainCapitalError(input: {
  environment: string;
  status: number;
  errorCode: string;
  message: string;
  bodyText: string;
}): string {
  const env = input.environment.toUpperCase();
  const code = input.errorCode || '(no errorCode)';

  const parts = [
    `Capital.com ${env} login failed (HTTP ${input.status}, ${code}).`,
  ];

  if (input.message && input.message.toLowerCase() !== 'bad request') {
    parts.push(`Broker says: ${input.message}`);
  } else if (input.bodyText && input.bodyText.length < 300) {
    parts.push(`Raw: ${input.bodyText}`);
  }

  parts.push(
    `2FA note: 2FA is only for creating the API key in the Capital.com website — do NOT paste the 2FA code into API Password.`,
    `Use the custom API password you set when generating the key (Settings → API integrations), NOT your account login password.`,
    `Checklist: (1) Live key for Live / Demo key for Demo.`,
    `(2) Identifier = login email.`,
    `(3) API Key = key string.`,
    `(4) API Password = custom password from key creation.`,
    `(5) Re-save broker row, Test again.`
  );

  return parts.join(' ');
}

async function createSession(
  base: string,
  apiKey: string,
  identifier: string,
  password: string,
  encryptedPassword: boolean
): Promise<{ res: Response; text: string; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1/session`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CAP-API-KEY': apiKey,
    },
    body: JSON.stringify({
      identifier,
      password,
      encryptedPassword,
    }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return { res, text, json };
}

async function resolveLoginPassword(
  base: string,
  apiKey: string,
  password: string
): Promise<Array<{ encrypted: boolean; password: string; label: string }>> {
  const attempts: Array<{ encrypted: boolean; password: string; label: string }> = [];
  try {
    const encRes = await fetch(`${base}/api/v1/session/encryptionKey`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-CAP-API-KEY': apiKey },
    });
    const encText = await encRes.text();
    if (encRes.ok) {
      const encJson = JSON.parse(encText) as { encryptionKey?: string; timeStamp?: number | string };
      if (encJson.encryptionKey != null && encJson.timeStamp != null) {
        attempts.push({
          encrypted: true,
          password: encryptCapitalPassword(encJson.encryptionKey, encJson.timeStamp, password),
          label: 'encrypted',
        });
      }
    }
  } catch {
    // ignore
  }
  attempts.push({ encrypted: false, password, label: 'plain' });
  return attempts;
}

export async function openCapitalSession(input: {
  environment: string;
  apiKey: string;
  identifier: string;
  password: string;
}): Promise<{ ok: true; session: CapitalSession } | { ok: false; result: CapitalComSessionResult }> {
  const apiKey = input.apiKey.trim();
  const identifier = input.identifier.trim();
  const password = input.password.trim();
  const environment = (input.environment || 'demo').toLowerCase();

  if (!apiKey || !identifier || !password) {
    return {
      ok: false,
      result: { ok: false, status: 0, detail: 'Missing identifier, API key, or password after trim' },
    };
  }
  if (apiKey.includes('@')) {
    return {
      ok: false,
      result: {
        ok: false,
        status: 0,
        detail:
          'API Key looks like an email. Put email in Identifier; paste Capital.com API Key into API Key.',
      },
    };
  }
  if (/^\d{6}$/.test(password)) {
    return {
      ok: false,
      result: {
        ok: false,
        status: 0,
        detail:
          'API Password looks like a 2FA code. Use the custom API password from key creation, not the authenticator code.',
      },
    };
  }

  const base = capitalComBaseUrl(environment);
  const attempts = await resolveLoginPassword(base, apiKey, password);
  let lastFail: CapitalComSessionResult | null = null;

  for (const attempt of attempts) {
    let res: Response;
    let text: string;
    let json: Record<string, unknown>;
    try {
      ({ res, text, json } = await createSession(
        base,
        apiKey,
        identifier,
        attempt.password,
        attempt.encrypted
      ));
    } catch (err) {
      return {
        ok: false,
        result: {
          ok: false,
          status: 0,
          detail: `Network error reaching Capital.com (${base}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      };
    }

    if (!res.ok) {
      const errorCode = String(json.errorCode || json.error || '');
      const message = String(json.message || json.errorMessage || json.errorReason || '');
      lastFail = {
        ok: false,
        status: res.status,
        errorCode: errorCode || undefined,
        detail: explainCapitalError({
          environment,
          status: res.status,
          errorCode,
          message: message || res.statusText || '',
          bodyText: text,
        }),
      };
      continue;
    }

    const cst = res.headers.get('CST') || res.headers.get('cst');
    const sec = res.headers.get('X-SECURITY-TOKEN') || res.headers.get('x-security-token');
    if (!cst || !sec) {
      lastFail = {
        ok: false,
        status: res.status,
        detail:
          'Capital.com returned HTTP OK but without CST / X-SECURITY-TOKEN headers. Check API key permissions for session create.',
      };
      continue;
    }

    const authHeaders = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CAP-API-KEY': apiKey,
      CST: cst,
      'X-SECURITY-TOKEN': sec,
    };

    const request = async (method: string, path: string, body?: unknown) => {
      const url = path.startsWith('http') ? path : `${base}${path}`;
      const r = await fetch(url, {
        method,
        headers: authHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const t = await r.text();
      let j: any = {};
      try {
        j = t ? JSON.parse(t) : {};
      } catch {
        j = {};
      }
      return { ok: r.ok, status: r.status, json: j, text: t };
    };

    const session: CapitalSession = {
      base,
      apiKey,
      cst,
      securityToken: sec,
      accountType: typeof json.accountType === 'string' ? json.accountType : undefined,
      currentAccountId:
        typeof json.currentAccountId === 'string'
          ? json.currentAccountId
          : typeof json.accountId === 'string'
            ? json.accountId
            : null,
      async close() {
        try {
          await fetch(`${base}/api/v1/session`, {
            method: 'DELETE',
            headers: {
              'X-CAP-API-KEY': apiKey,
              CST: cst,
              'X-SECURITY-TOKEN': sec,
            },
          });
        } catch {
          // ignore
        }
      },
      get: (path: string) => request('GET', path),
      post: (path: string, body?: unknown) => request('POST', path, body ?? {}),
      put: (path: string, body?: unknown) => request('PUT', path, body ?? {}),
      del: (path: string) => request('DELETE', path),
    };

    return { ok: true, session };
  }

  return {
    ok: false,
    result:
      lastFail || {
        ok: false,
        status: 0,
        detail: 'Capital.com session failed with no response',
      },
  };
}

type PooledCapital = {
  session: CapitalSession | null;
  raw: CapitalSession | null;
  expiresAt: number;
  cooldownUntil: number;
  activeCapitalAccountId: string | null;
};

const capitalSessionPool = new Map<string, PooledCapital>();
let loginChain: Promise<void> = Promise.resolve();
let lastLoginAt = 0;
const MIN_LOGIN_GAP_MS = 3500;
const COOLDOWN_429_MS = 120_000;

/** Isolate pool per broker connection so multi-client never shares sessions. */
function capitalPoolKey(connectionId: number): string {
  return `conn:${connectionId}`;
}

async function withLoginThrottle<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const prev = loginChain;
  loginChain = prev.then(() => gate);
  await prev;
  try {
    const wait = Math.max(0, MIN_LOGIN_GAP_MS - (Date.now() - lastLoginAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastLoginAt = Date.now();
    return await fn();
  } finally {
    release();
  }
}

export async function listCapitalAccounts(
  session: CapitalSession
): Promise<{ ok: boolean; accounts: Array<{ accountId: string; accountName: string; accountType?: string }>; detail: string }> {
  const res = await session.get('/api/v1/accounts');
  if (!res.ok) {
    return {
      ok: false,
      accounts: [],
      detail: `accounts HTTP ${res.status}: ${res.json?.errorCode || res.json?.message || res.text.slice(0, 120)}`,
    };
  }
  const raw = Array.isArray(res.json?.accounts) ? res.json.accounts : [];
  const accounts = raw
    .map((a: any) => ({
      accountId: String(a.accountId || a.account_id || '').trim(),
      accountName: String(a.accountName || a.name || a.accountId || '').trim(),
      accountType: a.accountType ? String(a.accountType) : undefined,
    }))
    .filter((a: { accountId: string }) => a.accountId);
  return { ok: true, accounts, detail: `${accounts.length} accounts` };
}

/** Account equity/balance for 10min risk window (% of total sum). */
export async function fetchCapitalAccountEquity(
  session: CapitalSession
): Promise<{ ok: boolean; equity: number | null; available: number | null; detail: string }> {
  const res = await session.get('/api/v1/accounts');
  if (!res.ok) {
    return {
      ok: false,
      equity: null,
      available: null,
      detail: `accounts HTTP ${res.status}: ${res.json?.errorCode || res.json?.message || res.text.slice(0, 120)}`,
    };
  }
  const raw = Array.isArray(res.json?.accounts) ? res.json.accounts : [];
  const want = String(session.currentAccountId || '').trim();
  const row =
    (want && raw.find((a: any) => String(a.accountId || a.account_id || '').trim() === want)) ||
    raw.find((a: any) => a.preferred) ||
    raw[0];
  if (!row) {
    return { ok: false, equity: null, available: null, detail: 'no Capital accounts in response' };
  }
  const bal = row.balance || row.accountBalance || {};
  const equity = numOrNull(
    bal.balance ?? bal.equity ?? bal.amount ?? row.balance ?? row.equity
  );
  const available = numOrNull(bal.available ?? bal.availableBalance ?? bal.deposit);
  if (equity == null || equity <= 0) {
    return {
      ok: false,
      equity: null,
      available,
      detail: `no equity on account ${row.accountId || '?'}`,
    };
  }
  return {
    ok: true,
    equity,
    available,
    detail: `equity=${equity}${available != null ? ` available=${available}` : ''}`,
  };
}

export async function switchCapitalAccount(
  session: CapitalSession,
  capitalAccountId: string
): Promise<{ ok: boolean; detail: string }> {
  const id = capitalAccountId.trim();
  if (!id) return { ok: false, detail: 'capital accountId required' };
  if (session.currentAccountId && session.currentAccountId === id) {
    return { ok: true, detail: `Already on account ${id}` };
  }
  const res = await session.put('/api/v1/session', { accountId: id });
  if (!res.ok) {
    return {
      ok: false,
      detail: `Switch account ${id} failed HTTP ${res.status}: ${
        res.json?.errorCode || res.json?.message || res.text.slice(0, 160)
      }`,
    };
  }
  session.currentAccountId = id;
  return { ok: true, detail: `Switched to Capital account ${id}` };
}

/**
 * Reuse Capital.com session per broker connection (multi-client safe).
 * Optionally switches to the correct Capital accountId for that desk account.
 */
export async function acquireCapitalSession(input: {
  environment: string;
  apiKey: string;
  identifier: string;
  password: string;
  connectionId: number;
  capitalAccountId?: string | null;
}): Promise<{ ok: true; session: CapitalSession } | { ok: false; result: CapitalComSessionResult }> {
  const connectionId = Number(input.connectionId);
  if (!Number.isFinite(connectionId) || connectionId <= 0) {
    return {
      ok: false,
      result: { ok: false, status: 0, detail: 'connectionId required for multi-account session pool' },
    };
  }

  const key = capitalPoolKey(connectionId);
  const now = Date.now();
  const cached = capitalSessionPool.get(key);
  const wantedAccount = (input.capitalAccountId || '').trim() || null;

  if (cached && cached.cooldownUntil > now) {
    const waitSec = Math.ceil((cached.cooldownUntil - now) / 1000);
    return {
      ok: false,
      result: {
        ok: false,
        status: 429,
        errorCode: 'error.too-many.requests',
        detail: `Capital.com rate-limit cooldown ${waitSec}s on connection #${connectionId} — other clients keep their own sessions.`,
      },
    };
  }

  let session: CapitalSession | null = null;
  let raw: CapitalSession | null = null;

  if (cached?.session && cached.expiresAt > now) {
    session = cached.session;
    raw = cached.raw;
  } else {
    if (cached?.raw) {
      try {
        await cached.raw.close();
      } catch {
        /* ignore */
      }
    }
    capitalSessionPool.delete(key);

    const opened = await withLoginThrottle(() =>
      openCapitalSession({
        environment: input.environment,
        apiKey: input.apiKey,
        identifier: input.identifier,
        password: input.password,
      })
    );
    if (!opened.ok) {
      const tooMany =
        opened.result.status === 429 ||
        /too-many|rate.?limit/i.test(opened.result.detail || '') ||
        /too-many/i.test(opened.result.errorCode || '');
      if (tooMany) {
        capitalSessionPool.set(key, {
          session: null,
          raw: null,
          expiresAt: 0,
          cooldownUntil: Date.now() + COOLDOWN_429_MS,
          activeCapitalAccountId: null,
        });
      }
      return opened;
    }

    raw = opened.session;
    session = {
      ...raw,
      close: async () => {
        /* no-op — pool owns lifetime */
      },
    };
  }

  if (wantedAccount && session) {
    const sw = await switchCapitalAccount(session, wantedAccount);
    if (!sw.ok) {
      return {
        ok: false,
        result: { ok: false, status: 400, detail: sw.detail },
      };
    }
  }

  capitalSessionPool.set(key, {
    session,
    raw,
    expiresAt: Date.now() + 8 * 60_000,
    cooldownUntil: 0,
    activeCapitalAccountId: wantedAccount || session?.currentAccountId || null,
  });
  return { ok: true, session: session! };
}

/** Drop a pooled session for one broker connection (e.g. after HTTP 401). */
export function invalidateCapitalSession(connectionId: number): void {
  const key = capitalPoolKey(connectionId);
  const cached = capitalSessionPool.get(key);
  if (!cached) return;
  void cached.raw?.close().catch(() => undefined);
  capitalSessionPool.delete(key);
}

export async function testCapitalComSession(input: {
  environment: string;
  apiKey: string;
  identifier: string;
  password: string;
}): Promise<CapitalComSessionResult> {
  const opened = await openCapitalSession(input);
  if (!opened.ok) return opened.result;
  await opened.session.close();
  return {
    ok: true,
    status: 200,
    detail: `Capital.com ${(input.environment || 'demo').toUpperCase()} session OK`,
    accountType: opened.session.accountType,
  };
}

export interface CapitalMarketQuote {
  epic: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  market_status: string | null;
  update_time: string | null;
  percentage_change: number | null;
  high: number | null;
  low: number | null;
  raw_ok: boolean;
  detail?: string;
  /** Raw Capital dealing-rules min stop (POINTS or PERCENTAGE) — use with stopDistance */
  min_stop_points?: number | null;
  min_stop_unit?: string | null;
  /** One instrument point in price units (for stopLevel calc) */
  point_size?: number | null;
  /** Minimum stop distance in PRICE units */
  min_stop_distance?: number | null;
}

function inferPointSize(json: any, mid: number | null): number {
  const snap = (json?.snapshot || json?.marketSnapshot || {}) as Record<string, unknown>;
  const rules = (json?.dealingRules || json?.dealing_rules || {}) as Record<string, any>;
  const decimalPlaces =
    numOrNull(snap.decimalPlacesFactor) ??
    numOrNull((json?.instrument as any)?.decimalPlacesFactor);
  const scaling = numOrNull(snap.scalingFactor) ?? 1;
  if (decimalPlaces != null && decimalPlaces >= 0 && decimalPlaces <= 8) {
    return Math.pow(10, -decimalPlaces) * (scaling > 0 ? scaling : 1);
  }
  const stepRaw = rules.minStepDistance;
  const stepVal = numOrNull(stepRaw?.value ?? stepRaw);
  const stepUnit = String(stepRaw?.unit || '').toUpperCase();
  if (stepVal != null && stepVal > 0 && !stepUnit.includes('PERCENT')) {
    // When Capital quotes minStep in POINTS, value is often already the price increment
    return stepVal;
  }
  const m = mid != null && Number.isFinite(mid) ? Math.abs(mid) : 1;
  if (m >= 1000) return 0.1;
  if (m >= 100) return 0.1;
  if (m >= 10) return 0.01;
  if (m >= 1) return 0.0001;
  return 0.00001;
}

function parseStopRules(
  json: any,
  mid: number | null
): {
  min_stop_points: number | null;
  min_stop_unit: string | null;
  point_size: number;
  min_stop_distance: number | null;
} {
  const rules = (json?.dealingRules || json?.dealing_rules || {}) as Record<string, any>;
  const raw =
    rules.minStopOrProfitDistance ||
    rules.minNormalStopOrLimitDistance ||
    rules.minStopDistance ||
    rules.minControlledRiskStopDistance;
  const pts = numOrNull(raw?.value ?? raw);
  const unit = String(raw?.unit || 'POINTS').toUpperCase();
  const pointSize = inferPointSize(json, mid);
  if (pts == null || pts <= 0) {
    return {
      min_stop_points: null,
      min_stop_unit: null,
      point_size: pointSize,
      min_stop_distance: null,
    };
  }
  if (unit.includes('PERCENT')) {
    const m = mid != null && Number.isFinite(mid) ? Math.abs(mid) : 1;
    return {
      min_stop_points: pts,
      min_stop_unit: unit,
      point_size: pointSize,
      min_stop_distance: (m * pts) / 100,
    };
  }
  // POINTS → price via instrument point size
  return {
    min_stop_points: pts,
    min_stop_unit: unit,
    point_size: pointSize,
    min_stop_distance: pts * pointSize,
  };
}

/** Live Capital.com market snapshot for one epic (REST). No synthetic values. */
export async function fetchCapitalMarketQuote(
  session: CapitalSession,
  epic: string
): Promise<CapitalMarketQuote> {
  const clean = epic.trim();
  if (!clean) {
    return {
      epic: '',
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      market_status: null,
      update_time: null,
      percentage_change: null,
      high: null,
      low: null,
      raw_ok: false,
      detail: 'Empty epic',
    };
  }

  const tryEpic = async (candidate: string): Promise<CapitalMarketQuote> => {
    const res = await session.get(`/api/v1/markets/${encodeURIComponent(candidate)}`);
    if (!res.ok) {
      return {
        epic: candidate,
        bid: null,
        ask: null,
        mid: null,
        spread: null,
        market_status: null,
        update_time: null,
        percentage_change: null,
        high: null,
        low: null,
        raw_ok: false,
        detail: `Capital.com markets/${candidate} HTTP ${res.status}: ${
          res.json?.errorCode || res.json?.message || res.text.slice(0, 160)
        }`,
      };
    }

    const snap = (res.json?.snapshot || res.json?.marketSnapshot || {}) as Record<string, unknown>;
    const bid = numOrNull(snap.bid ?? snap.bidPrice);
    const ask = numOrNull(snap.offer ?? snap.ask ?? snap.offerPrice);
    let mid: number | null = null;
    if (bid != null && ask != null) mid = (bid + ask) / 2;
    else mid = numOrNull(snap.mid ?? snap.lastTraded);
    const spread = bid != null && ask != null ? ask - bid : null;
    const stops = parseStopRules(res.json, mid);

    return {
      epic: candidate,
      bid,
      ask,
      mid,
      spread,
      market_status: strOrNull(snap.marketStatus ?? res.json?.instrument?.marketStatus),
      update_time: strOrNull(snap.updateTime ?? snap.updateTimeUTC ?? snap.binaryUpdateTime),
      percentage_change: numOrNull(snap.percentageChange),
      high: numOrNull(snap.high),
      low: numOrNull(snap.low),
      raw_ok: bid != null || ask != null || mid != null,
      min_stop_points: stops.min_stop_points,
      min_stop_unit: stops.min_stop_unit,
      point_size: stops.point_size,
      min_stop_distance: stops.min_stop_distance,
      detail: bid == null && ask == null ? 'Snapshot returned without bid/offer' : undefined,
    };
  };

  let quote = await tryEpic(clean);
  if (quote.raw_ok) return quote;

  // Resolve human names like "gold" / "gold x" via Capital search
  const resolved = await resolveEpicViaSearch(session, clean);
  if (resolved && resolved !== clean) {
    quote = await tryEpic(resolved);
    if (quote.raw_ok) {
      quote.detail = `Resolved "${clean}" → epic ${resolved}`;
      return quote;
    }
  }
  return quote;
}

/** Search Capital.com markets API for an epic/name (e.g. gold → GOLD). */
export async function resolveEpicViaSearch(
  session: CapitalSession,
  query: string
): Promise<string | null> {
  const q = query.trim();
  if (!q) return null;
  const res = await session.get(`/api/v1/markets?searchTerm=${encodeURIComponent(q)}`);
  if (!res.ok) return null;
  const markets = Array.isArray(res.json?.markets) ? res.json.markets : [];
  if (markets.length === 0) return null;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const qn = norm(q);
  let best: { epic: string; score: number } | null = null;
  for (const m of markets) {
    const epic = String(m.epic || '').trim();
    if (!epic) continue;
    const name = String(m.instrumentName || m.displayName || m.name || '');
    const en = norm(epic);
    const nn = norm(name);
    let score = 0;
    if (en === qn || nn === qn) score = 100;
    else if (en.includes(qn) || nn.includes(qn) || qn.includes(en)) score = 70;
    else if (qn.includes('gold') && (en.includes('gold') || nn.includes('gold') || en.includes('xau')))
      score = 60;
    if (!best || score > best.score) best = { epic, score };
  }
  return best && best.score >= 60 ? best.epic : String(markets[0].epic || '') || null;
}

export type CapitalOpenPosition = {
  deal_id: string;
  deal_reference: string | null;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  open_level: number | null;
  upl: number | null;
  stop_level: number | null;
};

/** All open Capital.com positions (REST). */
export async function listCapitalOpenPositions(
  session: CapitalSession
): Promise<{ ok: boolean; positions: CapitalOpenPosition[]; detail: string }> {
  const res = await session.get('/api/v1/positions');
  if (!res.ok) {
    return {
      ok: false,
      positions: [],
      detail: `Capital.com positions HTTP ${res.status}: ${
        res.json?.errorCode || res.json?.message || res.text.slice(0, 160)
      }`,
    };
  }
  const raw = Array.isArray(res.json?.positions) ? res.json.positions : [];
  const positions: CapitalOpenPosition[] = [];
  for (const row of raw) {
    const pos = (row?.position || row || {}) as Record<string, unknown>;
    const market = (row?.market || {}) as Record<string, unknown>;
    const dealId = String(pos.dealId || pos.deal_id || '').trim();
    const epic = String(market.epic || pos.epic || '').trim();
    if (!dealId || !epic) continue;
    const dirRaw = String(pos.direction || '').toUpperCase();
    const direction: 'BUY' | 'SELL' = dirRaw === 'SELL' ? 'SELL' : 'BUY';
    positions.push({
      deal_id: dealId,
      deal_reference: strOrNull(pos.dealReference),
      epic,
      direction,
      size: numOrNull(pos.size) ?? 0,
      open_level: numOrNull(pos.level ?? pos.openLevel ?? pos.averagePrice),
      upl: numOrNull(pos.upl ?? pos.unrealizedProfit ?? pos.profit),
      stop_level: numOrNull(pos.stopLevel ?? pos.stop_level),
    });
  }
  return { ok: true, positions, detail: `${positions.length} open` };
}

/** Resolve dealReference → dealId after open. */
export async function confirmCapitalDeal(
  session: CapitalSession,
  dealReference: string
): Promise<{ ok: boolean; deal_id?: string; detail: string }> {
  const ref = dealReference.trim();
  if (!ref) return { ok: false, detail: 'Empty dealReference' };
  const res = await session.get(`/api/v1/confirms/${encodeURIComponent(ref)}`);
  if (!res.ok) {
    return {
      ok: false,
      detail: `Confirm HTTP ${res.status}: ${res.json?.errorCode || res.json?.message || res.text.slice(0, 120)}`,
    };
  }
  const dealId = String(
    res.json?.dealId || res.json?.affectedDeals?.[0]?.dealId || ''
  ).trim();
  if (!dealId) {
    return { ok: false, detail: `Confirm OK but no dealId for ${ref}` };
  }
  return { ok: true, deal_id: dealId, detail: `Confirmed dealId=${dealId}` };
}

/** Close one open position by dealId. */
export async function closeCapitalPosition(
  session: CapitalSession,
  dealId: string
): Promise<{ ok: boolean; deal_reference?: string; detail: string; status: number; json: any }> {
  const id = dealId.trim();
  if (!id) {
    return { ok: false, status: 0, json: {}, detail: 'dealId required to close' };
  }
  const res = await session.del(`/api/v1/positions/${encodeURIComponent(id)}`);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      json: res.json,
      detail: `Capital.com close ${id} failed HTTP ${res.status}: ${
        res.json?.errorCode || res.json?.message || res.text.slice(0, 240)
      }`,
    };
  }
  const dealRef = String(res.json?.dealReference || res.json?.dealId || '');
  return {
    ok: true,
    status: res.status,
    json: res.json,
    deal_reference: dealRef || undefined,
    detail: dealRef ? `Closed dealId=${id} dealRef=${dealRef}` : `Closed dealId=${id}`,
  };
}

export async function createCapitalPosition(
  session: CapitalSession,
  input: {
    epic: string;
    direction: 'BUY' | 'SELL';
    size: number;
    /** Absolute price stop (Capital stopLevel) */
    stopLevel?: number;
    /** Distance in Capital POINTS — preferred for tightest legal SL */
    stopDistance?: number;
    profitLevel?: number;
  }
): Promise<{ ok: boolean; deal_reference?: string; detail: string; status: number; json: any }> {
  let epic = input.epic.trim();
  const quote = await fetchCapitalMarketQuote(session, epic);
  if (quote.raw_ok && quote.epic) epic = quote.epic;
  else if (!quote.raw_ok) {
    const resolved = await resolveEpicViaSearch(session, epic);
    if (resolved) epic = resolved;
  }

  const body: Record<string, unknown> = {
    epic,
    direction: input.direction,
    size: input.size,
  };
  // Capital accepts only one of stopLevel / stopDistance — prefer distance for min legal SL
  if (input.stopDistance != null && Number.isFinite(input.stopDistance) && input.stopDistance > 0) {
    body.stopDistance = input.stopDistance;
  } else if (input.stopLevel != null && Number.isFinite(input.stopLevel)) {
    body.stopLevel = input.stopLevel;
  }
  if (input.profitLevel != null && Number.isFinite(input.profitLevel)) {
    body.profitLevel = input.profitLevel;
  }

  const res = await session.post('/api/v1/positions', body);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      json: res.json,
      detail: `Capital.com open ${input.direction} ${epic} failed HTTP ${res.status}: ${
        res.json?.errorCode || res.json?.message || res.text.slice(0, 240)
      }`,
    };
  }
  const dealRef = String(res.json?.dealReference || res.json?.dealId || '');
  const slNote =
    input.stopDistance != null && Number.isFinite(input.stopDistance)
      ? ` stopDist=${input.stopDistance}`
      : input.stopLevel != null && Number.isFinite(input.stopLevel)
        ? ` stop=${input.stopLevel}`
        : '';
  return {
    ok: true,
    status: res.status,
    json: res.json,
    deal_reference: dealRef || undefined,
    detail: dealRef
      ? `Opened ${input.direction} ${epic} size=${input.size}${slNote} dealRef=${dealRef}`
      : `Opened ${input.direction} ${epic} size=${input.size}${slNote}`,
  };
}

/** ~0.13% disaster cushion stopLevel (≥2× broker min) — wider than HardInv 0.08%. */
export function computeSafetyCushionStopLevel(
  direction: 'BUY' | 'SELL',
  mid: number,
  opts?: {
    bid?: number | null;
    ask?: number | null;
    spread?: number | null;
    minStopDistance?: number | null;
  }
): number {
  const bid = opts?.bid ?? null;
  const ask = opts?.ask ?? null;
  const ref =
    direction === 'BUY'
      ? bid != null && Number.isFinite(bid)
        ? bid
        : mid
      : ask != null && Number.isFinite(ask)
        ? ask
        : mid;
  const abs = Math.max(Math.abs(ref), 1e-9);
  const spr =
    opts?.spread != null && opts.spread > 0
      ? opts.spread
      : bid != null && ask != null
        ? Math.max(ask - bid, 0)
        : abs * 0.00005;
  const brokerMin =
    opts?.minStopDistance != null && opts.minStopDistance > 0 ? opts.minStopDistance : 0;
  const pctCushion = abs * 0.0013; // 0.13% — wider than HardInv 0.08%
  const floor = abs >= 1000 ? 0.35 : abs >= 100 ? 0.15 : abs >= 10 ? 0.025 : 0.00025;
  const dist = Math.max(pctCushion, brokerMin * 2, spr * 5, floor);
  const raw = direction === 'BUY' ? ref - dist : ref + dist;
  if (abs >= 1000) return Math.round(raw * 10) / 10;
  if (abs >= 100) return Math.round(raw * 100) / 100;
  if (abs >= 1) return Math.round(raw * 10000) / 10000;
  return Math.round(raw * 1e6) / 1e6;
}

export type CapitalPriceCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
};

/** Capital OHLC — SECOND for 10s bars, MINUTE for chase filter. */
export async function fetchCapitalPrices(
  session: CapitalSession,
  epic: string,
  resolution: 'SECOND' | 'MINUTE' = 'MINUTE',
  max = 5
): Promise<{ ok: boolean; candles: CapitalPriceCandle[]; detail: string }> {
  const encoded = encodeURIComponent(epic.trim());
  const cap = resolution === 'SECOND' ? 50 : 20;
  const q = new URLSearchParams({
    resolution,
    max: String(Math.min(Math.max(max, 1), cap)),
  });
  let res = await session.get(`/api/v1/prices/${encoded}?${q.toString()}`);
  if (!res.ok) {
    q.set('epic', epic.trim());
    res = await session.get(`/api/v1/prices?${q.toString()}`);
  }
  if (!res.ok) {
    res = await session.get(
      `/api/v1/history/prices?epic=${encoded}&resolution=${resolution}&max=${Math.min(Math.max(max, 1), cap)}`
    );
  }
  const prices = (res.json?.prices || res.json?.candles || []) as any[];
  const candles: CapitalPriceCandle[] = [];
  for (const p of prices) {
    const open = numOrNull(p.openPrice?.bid ?? p.openPrice?.ask ?? p.open ?? p.o);
    const high = numOrNull(p.highPrice?.bid ?? p.highPrice?.ask ?? p.high ?? p.h);
    const low = numOrNull(p.lowPrice?.bid ?? p.lowPrice?.ask ?? p.low ?? p.l);
    const close = numOrNull(p.closePrice?.bid ?? p.closePrice?.ask ?? p.close ?? p.c);
    if (open == null || high == null || low == null || close == null) continue;
    candles.push({ open, high, low, close });
  }
  return { ok: candles.length > 0, candles, detail: `${candles.length} ${resolution} candles` };
}

export async function fetchCapitalMinutePrices(
  session: CapitalSession,
  epic: string,
  max = 5
): Promise<{ ok: boolean; candles: CapitalPriceCandle[]; detail: string }> {
  return fetchCapitalPrices(session, epic, 'MINUTE', max);
}

/**
 * True if the latest 1m candle already moved hard in trade direction (~end of move).
 * Blocks chase entries — ~0.12% of price (~5.5pt Gold).
 */
export function isLateMoveOnOneMinute(
  direction: 'BUY' | 'SELL',
  candles: CapitalPriceCandle[]
): boolean {
  if (!candles.length) return false;
  const last = candles[candles.length - 1]!;
  const mid = Math.max(Math.abs(last.open), 1e-9);
  const move = last.close - last.open;
  const thr = Math.max(mid * 0.0012, 0.05);
  if (direction === 'BUY' && move >= thr) return true;
  if (direction === 'SELL' && move <= -thr) return true;
  return false;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mapInstrumentType(instrumentType: string, pathNames: string[]): string {
  const t = (instrumentType || '').toUpperCase();
  const path = pathNames.join(' ').toLowerCase();
  if (t.includes('CURREN') || path.includes('forex') || path.includes('fx')) return 'fx';
  if (t.includes('CRYPTO') || path.includes('crypto')) return 'crypto';
  if (t.includes('INDICES') || t.includes('INDEX') || path.includes('indices')) return 'indices';
  if (t.includes('COMMOD') || path.includes('commodit') || path.includes('metal') || path.includes('oil')) {
    if (path.includes('metal') || /xau|xag|gold|silver/i.test(path)) return 'metals';
    if (path.includes('oil') || path.includes('energy')) return 'energy';
    return 'commodities';
  }
  if (t.includes('SHARE') || t.includes('EQUIT') || path.includes('share') || path.includes('stock')) {
    return 'shares';
  }
  return (instrumentType || pathNames[0] || 'other').toLowerCase() || 'other';
}

function lotDefaults(category: string): { min_lot: number; max_lot: number; lot_step: number } {
  if (category === 'fx' || category === 'crypto') return { min_lot: 0.01, max_lot: 100, lot_step: 0.01 };
  if (category === 'indices') return { min_lot: 0.1, max_lot: 100, lot_step: 0.1 };
  if (category === 'shares') return { min_lot: 1, max_lot: 10000, lot_step: 1 };
  return { min_lot: 0.01, max_lot: 100, lot_step: 0.01 };
}

function normalizeMarket(raw: Record<string, any>, pathNames: string[]): CapitalMarket | null {
  const epic = String(raw.epic || raw.instrumentEpic || '').trim();
  if (!epic) return null;
  const display =
    String(raw.instrumentName || raw.displayName || raw.name || epic).trim() || epic;
  const instrumentType = String(raw.instrumentType || raw.type || '');
  const category = mapInstrumentType(instrumentType, pathNames);
  const lots = lotDefaults(category);
  // Prefer dealing rules when present
  const minDeal = Number(raw.dealingRules?.minDealSize?.value ?? raw.minDealSize ?? lots.min_lot);
  const maxDeal = Number(raw.dealingRules?.maxDealSize?.value ?? raw.maxDealSize ?? lots.max_lot);
  const step = Number(raw.dealingRules?.dealSizeStep?.value ?? raw.dealSizeStep ?? lots.lot_step);
  return {
    epic,
    symbol: epic,
    display_name: display,
    instrument_type: instrumentType || category,
    category,
    min_lot: Number.isFinite(minDeal) && minDeal > 0 ? minDeal : lots.min_lot,
    max_lot: Number.isFinite(maxDeal) && maxDeal > 0 ? maxDeal : lots.max_lot,
    lot_step: Number.isFinite(step) && step > 0 ? step : lots.lot_step,
  };
}

/**
 * Walk Capital.com market navigation recursively and collect every market epic/name.
 * Also supplements with /markets?searchTerm= sweeps so sparse nodes are not missed.
 */
export async function fetchAllCapitalMarkets(
  session: CapitalSession,
  opts?: { onProgress?: (count: number, note: string) => void }
): Promise<CapitalMarket[]> {
  const byEpic = new Map<string, CapitalMarket>();
  const visitedNodes = new Set<string>();

  const addMarkets = (arr: any[] | undefined, pathNames: string[]) => {
    if (!Array.isArray(arr)) return;
    for (const raw of arr) {
      const m = normalizeMarket(raw, pathNames);
      if (!m) continue;
      if (!byEpic.has(m.epic)) {
        byEpic.set(m.epic, m);
        opts?.onProgress?.(byEpic.size, m.display_name);
      }
    }
  };

  const walk = async (nodeId: string | null, pathNames: string[], depth: number) => {
    if (depth > 12) return;
    const path = nodeId
      ? `/api/v1/marketnavigation/${encodeURIComponent(nodeId)}`
      : '/api/v1/marketnavigation';
    if (nodeId) {
      if (visitedNodes.has(nodeId)) return;
      visitedNodes.add(nodeId);
    }

    await sleep(120); // respect Capital.com rate limits
    const res = await session.get(path);
    if (!res.ok) return;

    addMarkets(res.json.markets, pathNames);

    const nodes = Array.isArray(res.json.nodes) ? res.json.nodes : [];
    for (const node of nodes) {
      const id = String(node.id ?? node.nodeId ?? '');
      const name = String(node.name ?? node.nodeName ?? id);
      if (!id) continue;
      await walk(id, [...pathNames, name], depth + 1);
    }
  };

  await walk(null, [], 0);

  // Supplement: search sweep catches instruments not linked in navigation.
  const terms = [
    ...'abcdefghijklmnopqrstuvwxyz'.split(''),
    ...'0123456789'.split(''),
    'EUR', 'USD', 'GBP', 'JPY', 'XAU', 'BTC', 'ETH', 'NAS', 'US5', 'OIL', 'GOLD',
  ];
  for (const term of terms) {
    await sleep(120);
    const res = await session.get(`/api/v1/markets?searchTerm=${encodeURIComponent(term)}`);
    if (!res.ok) continue;
    const markets = Array.isArray(res.json.markets) ? res.json.markets : [];
    addMarkets(markets, ['search', term]);
  }

  return [...byEpic.values()].sort((a, b) =>
    a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' })
  );
}
