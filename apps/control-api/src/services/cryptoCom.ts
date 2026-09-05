import { createHmac } from 'crypto';

/** Crypto.com Exchange REST roots (Exchange API v1). */
export function cryptoComBaseUrl(environment: string): string {
  // demo → Exchange UAT sandbox; live → production
  return environment === 'live'
    ? 'https://api.crypto.com/exchange/v1'
    : 'https://uat-api.3ona.co/exchange/v1';
}

export interface CryptoComMarket {
  epic: string;
  symbol: string;
  display_name: string;
  instrument_type: string;
  category: string;
  min_lot: number;
  max_lot: number;
  lot_step: number;
}

export interface CryptoComTestResult {
  ok: boolean;
  status: number;
  detail: string;
  errorCode?: string;
  accountLabel?: string;
}

type Json = Record<string, unknown>;

/** Strip paste artifacts that break HMAC (BOM, zero-width, newlines). */
export function sanitizeCryptoComSecret(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim();
}

/**
 * Crypto.com parameter string for HMAC:
 * sorted keys, each key + value, nested objects recurse, arrays concatenate elements.
 * @see https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html#digital-signature
 */
export function paramsToString(obj: unknown, level = 0): string {
  if (obj === null || obj === undefined) return 'null';
  if (level >= 3) return String(obj);
  if (Array.isArray(obj)) {
    return obj.map((item) => paramsToString(item, level + 1)).join('');
  }
  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .map((key) => `${key}${paramsToString(record[key], level + 1)}`)
      .join('');
  }
  return String(obj);
}

/** Build HMAC-SHA256 hex signature for a private request. */
export function signRequest(input: {
  method: string;
  id: number | string;
  apiKey: string;
  params: Json;
  nonce: number | string;
  apiSecret: string;
}): string {
  const paramStr = paramsToString(input.params || {});
  const payload = `${input.method}${input.id}${input.apiKey}${paramStr}${input.nonce}`;
  return createHmac('sha256', input.apiSecret).update(payload).digest('hex');
}

function authFailureHint(environment: string, code?: string | number): string {
  const envLabel = environment === 'live' ? 'Live (production)' : 'Demo (UAT)';
  const otherEnv = environment === 'live' ? 'Demo (UAT)' : 'Live';
  return [
    `Auth rejected (${code ?? 'unauthorized'}) for ${envLabel}.`,
    'Fix checklist:',
    '1) Key must be from Crypto.com Exchange → User Center → API (not the Crypto.com App).',
    '2) Paste API Key in API Key and API Secret in API Secret — do not swap them.',
    `3) Environment must match the key: ${envLabel} keys fail on ${otherEnv}.`,
    '4) If the key has an IP whitelist, allow this server IP (error 40103 / 10003).',
    '5) Delete the row and re-save after regenerating the key if unsure.',
  ].join('\n');
}

async function postSigned(input: {
  environment: string;
  method: string;
  apiKey?: string;
  apiSecret?: string;
  params?: Json;
}): Promise<{ status: number; json: Json }> {
  const base = cryptoComBaseUrl(input.environment);
  // Use millisecond nonce as id (matches working CCXT / Exchange clients).
  const nonce = Date.now();
  const id = nonce;
  const params = input.params || {};
  const body: Json = {
    id,
    method: input.method,
    params,
    nonce,
  };

  if (input.apiKey && input.apiSecret) {
    body.api_key = input.apiKey;
    body.sig = signRequest({
      method: input.method,
      id,
      apiKey: input.apiKey,
      params,
      nonce,
      apiSecret: input.apiSecret,
    });
  }

  const res = await fetch(`${base}/${input.method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  let json: Json = {};
  try {
    json = (await res.json()) as Json;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

async function getPublic(input: {
  environment: string;
  method: string;
  query?: Record<string, string>;
}): Promise<{ status: number; json: Json }> {
  const base = cryptoComBaseUrl(input.environment);
  const qs = input.query ? `?${new URLSearchParams(input.query).toString()}` : '';
  const res = await fetch(`${base}/${input.method}${qs}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  let json: Json = {};
  try {
    json = (await res.json()) as Json;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

function apiErrorDetail(json: Json, fallback: string): string {
  const code = json.code;
  const message = json.message || json.msg;
  if (code !== undefined && Number(code) !== 0) {
    return `Crypto.com error code=${code}${message ? `: ${String(message)}` : ''}`;
  }
  if (typeof message === 'string' && message.trim()) return message;
  return fallback;
}

function isAuthError(code: unknown, status: number): boolean {
  const n = Number(code);
  return (
    status === 401 ||
    status === 403 ||
    n === 10002 ||
    n === 40101 ||
    n === 10003 ||
    n === 40103
  );
}

function qtyStepFromInstrument(raw: Record<string, unknown>): number {
  const tick = Number(raw.qty_tick_size ?? raw.quantity_tick_size);
  if (Number.isFinite(tick) && tick > 0) return tick;
  const decimals = Number(raw.quantity_decimals ?? raw.qty_decimals);
  if (Number.isFinite(decimals) && decimals >= 0) {
    return Number((10 ** -decimals).toFixed(Math.min(decimals, 8)));
  }
  return 0.0001;
}

function normalizeInstrument(raw: Record<string, unknown>): CryptoComMarket | null {
  const symbol = String(raw.symbol || raw.instrument_name || '').trim();
  if (!symbol) return null;
  const tradable = raw.tradable === undefined ? true : Boolean(raw.tradable);
  if (!tradable) return null;

  const instType = String(raw.inst_type || raw.instrument_type || 'CCY_PAIR').toUpperCase();
  const display = String(raw.display_name || raw.symbol || symbol).trim() || symbol;
  const lotStep = qtyStepFromInstrument(raw);
  const minLot = Number(raw.min_quantity ?? raw.min_qty ?? lotStep);
  const maxLot = Number(raw.max_quantity ?? raw.max_qty ?? 1_000_000);

  return {
    epic: symbol,
    symbol,
    display_name: display,
    instrument_type: instType || 'crypto',
    category: 'crypto',
    min_lot: Number.isFinite(minLot) && minLot > 0 ? minLot : lotStep,
    max_lot: Number.isFinite(maxLot) && maxLot > 0 ? maxLot : 1_000_000,
    lot_step: lotStep,
  };
}

/**
 * Validate API key + secret against Crypto.com Exchange (private/user-balance).
 * Prefer user-balance over get-accounts: the latter is sub-account oriented and
 * often returns legacy 10002 for retail keys even when the key is valid.
 * API Secret is stored in the shared `password` credential slot.
 */
export async function testCryptoComSession(input: {
  environment: string;
  apiKey: string;
  apiSecret: string;
}): Promise<CryptoComTestResult> {
  const apiKey = sanitizeCryptoComSecret(input.apiKey);
  const apiSecret = sanitizeCryptoComSecret(input.apiSecret);
  if (!apiKey || !apiSecret) {
    return { ok: false, status: 400, detail: 'Crypto.com needs API Key and API Secret' };
  }
  if (apiKey === apiSecret) {
    return {
      ok: false,
      status: 400,
      detail: 'API Key and API Secret look identical — paste each value into its own field',
    };
  }

  try {
    const { status, json } = await postSigned({
      environment: input.environment,
      method: 'private/user-balance',
      apiKey,
      apiSecret,
      params: {},
    });

    if (isAuthError(json.code, status)) {
      const code = String(json.code ?? status);
      const ipHint = Number(json.code) === 10003 || Number(json.code) === 40103;
      return {
        ok: false,
        status,
        detail: ipHint
          ? `Crypto.com IP not whitelisted (code=${code}). Add this server IP to the API key whitelist, or disable IP restriction on the key.`
          : `${apiErrorDetail(json, 'Unauthorized')}\n\n${authFailureHint(input.environment, code)}`,
        errorCode: code,
      };
    }

    if (!status.toString().startsWith('2') || (json.code !== undefined && Number(json.code) !== 0)) {
      return {
        ok: false,
        status,
        detail: apiErrorDetail(json, `HTTP ${status} from Crypto.com`),
        errorCode: String(json.code ?? status),
      };
    }

    const result = (json.result || {}) as Json;
    const data = Array.isArray(result.data) ? result.data : [];
    const first = (data[0] || {}) as Json;
    const instrument = String(first.instrument_name || first.currency || 'USD').trim() || 'USD';
    const cash = first.total_cash_balance ?? first.total_available_balance;
    const label =
      cash != null && String(cash).trim()
        ? `${instrument} bal ${String(cash)}`
        : instrument;

    return {
      ok: true,
      status,
      detail: `Crypto.com ${input.environment === 'live' ? 'LIVE' : 'UAT'} OK · ${label}`,
      accountLabel: label,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : 'Crypto.com connection failed',
    };
  }
}

/** Public instrument catalog (no auth). */
export async function fetchAllCryptoComMarkets(input: {
  environment: string;
}): Promise<CryptoComMarket[]> {
  const { status, json } = await getPublic({
    environment: input.environment,
    method: 'public/get-instruments',
  });

  if (!status.toString().startsWith('2') || (json.code !== undefined && Number(json.code) !== 0)) {
    throw new Error(apiErrorDetail(json, `Failed to load Crypto.com instruments (HTTP ${status})`));
  }

  const result = (json.result || {}) as Json;
  const rows = Array.isArray(result.data)
    ? result.data
    : Array.isArray(result.instruments)
      ? result.instruments
      : [];

  const byEpic = new Map<string, CryptoComMarket>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const m = normalizeInstrument(raw as Record<string, unknown>);
    if (!m) continue;
    if (!byEpic.has(m.epic)) byEpic.set(m.epic, m);
  }
  return [...byEpic.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export async function createCryptoComOrder(input: {
  environment: string;
  apiKey: string;
  apiSecret: string;
  instrument: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  type?: 'MARKET' | 'LIMIT';
  price?: number;
}): Promise<{ ok: boolean; status: number; detail: string; orderId?: string; json?: Json }> {
  const qty = Number(input.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, status: 400, detail: 'quantity must be > 0' };
  }

  const params: Json = {
    instrument_name: input.instrument.trim(),
    side: input.side,
    type: input.type || 'MARKET',
    quantity: String(qty),
  };
  if (input.type === 'LIMIT' && input.price != null) {
    params.price = String(input.price);
  }

  try {
    const { status, json } = await postSigned({
      environment: input.environment,
      method: 'private/create-order',
      apiKey: sanitizeCryptoComSecret(input.apiKey),
      apiSecret: sanitizeCryptoComSecret(input.apiSecret),
      params,
    });

    if (!status.toString().startsWith('2') || (json.code !== undefined && Number(json.code) !== 0)) {
      return {
        ok: false,
        status,
        detail: apiErrorDetail(json, `Order rejected (HTTP ${status})`),
        json,
      };
    }

    const result = (json.result || {}) as Json;
    const orderId = String(result.order_id || result.client_oid || '').trim() || undefined;
    return {
      ok: true,
      status,
      detail: orderId
        ? `Crypto.com order accepted · id=${orderId}`
        : 'Crypto.com order accepted',
      orderId,
      json,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : 'Crypto.com order failed',
    };
  }
}
