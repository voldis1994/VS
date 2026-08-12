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
  close: () => Promise<void>;
  get: (path: string) => Promise<{ ok: boolean; status: number; json: any; text: string }>;
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

    const session: CapitalSession = {
      base,
      apiKey,
      cst,
      securityToken: sec,
      accountType: typeof json.accountType === 'string' ? json.accountType : undefined,
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
      async get(path: string) {
        const url = path.startsWith('http') ? path : `${base}${path}`;
        const r = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-CAP-API-KEY': apiKey,
            CST: cst,
            'X-SECURITY-TOKEN': sec,
          },
        });
        const t = await r.text();
        let j: any = {};
        try {
          j = t ? JSON.parse(t) : {};
        } catch {
          j = {};
        }
        return { ok: r.ok, status: r.status, json: j, text: t };
      },
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
