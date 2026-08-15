/**
 * Capital.com official REST session manager (P2).
 * Direct api-capital / demo-api-capital only — no Cloudflare/browser/VPS proxy.
 *
 * Owns: proactive refresh, keepalive, 401 invalidate+retry, 429 cooldown,
 * stale-feed age tracking, broker error parsing for System Health.
 */
import {
  acquireCapitalSession,
  invalidateCapitalSession,
  type CapitalComSessionResult,
  type CapitalSession,
} from './capitalCom.js';
import { DecisionCodes, type DecisionCode } from './decisionCodes.js';

export type CapitalSessionHealthLevel = 'OK' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type CapitalSessionHealth = {
  connection_id: number;
  level: CapitalSessionHealthLevel;
  code: DecisionCode | 'OK';
  detail: string;
  has_cst: boolean;
  has_security_token: boolean;
  expires_in_ms: number | null;
  last_ok_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  retry_count: number;
  feed_age_ms: number | null;
  rate_limited_until: string | null;
};

type Tracked = {
  connectionId: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  retryCount: number;
  lastFeedAt: number | null;
  expiresAt: number | null;
  cooldownUntil: number | null;
  hasCst: boolean;
  hasSec: boolean;
};

const track = new Map<number, Tracked>();
const SESSION_TTL_MS = 8 * 60_000;
const REFRESH_BEFORE_MS = 90_000;
const DEFAULT_STALE_FEED_MS = 15_000;

function ensureTrack(connectionId: number): Tracked {
  let t = track.get(connectionId);
  if (!t) {
    t = {
      connectionId,
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
      retryCount: 0,
      lastFeedAt: null,
      expiresAt: null,
      cooldownUntil: null,
      hasCst: false,
      hasSec: false,
    };
    track.set(connectionId, t);
  }
  return t;
}

export function parseCapitalBrokerError(input: {
  status: number;
  json?: unknown;
  text?: string;
  detail?: string;
}): { code: DecisionCode; message: string; broker_code: string | null } {
  const json = (input.json || {}) as Record<string, unknown>;
  const broker =
    String(json.errorCode || json.error || json.errorReason || '').trim() || null;
  const msg =
    String(
      input.detail ||
        json.message ||
        json.errorMessage ||
        json.errorReason ||
        input.text ||
        ''
    ).slice(0, 400) || `HTTP ${input.status}`;

  if (input.status === 401 || /unauthor|expired|security.?token|cst/i.test(msg + (broker || ''))) {
    return { code: DecisionCodes.SESSION_EXPIRED, message: msg, broker_code: broker };
  }
  if (input.status === 429 || /too-many|rate.?limit/i.test(msg + (broker || ''))) {
    return { code: DecisionCodes.RATE_LIMITED, message: msg, broker_code: broker };
  }
  if (input.status === 0 || /timeout|network|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg)) {
    return { code: DecisionCodes.NETWORK_TIMEOUT, message: msg, broker_code: broker };
  }
  if (/reject|denied|validation|insufficient|error\./i.test(msg + (broker || ''))) {
    return { code: DecisionCodes.BROKER_REJECTED, message: msg, broker_code: broker };
  }
  return { code: DecisionCodes.ERROR_BROKER, message: msg, broker_code: broker };
}

export function recordCapitalSessionOk(connectionId: number, session: CapitalSession): void {
  const t = ensureTrack(connectionId);
  t.lastOkAt = Date.now();
  t.hasCst = Boolean(session.cst);
  t.hasSec = Boolean(session.securityToken);
  t.expiresAt = Date.now() + SESSION_TTL_MS;
  t.cooldownUntil = null;
  t.retryCount = 0;
  t.lastError = null;
}

export function recordCapitalSessionError(
  connectionId: number,
  detail: string,
  opts?: { rateLimitMs?: number }
): void {
  const t = ensureTrack(connectionId);
  t.lastErrorAt = Date.now();
  t.lastError = detail.slice(0, 500);
  t.retryCount += 1;
  if (opts?.rateLimitMs && opts.rateLimitMs > 0) {
    t.cooldownUntil = Date.now() + opts.rateLimitMs;
  }
}

export function recordCapitalFeedTick(connectionId: number, atMs = Date.now()): void {
  ensureTrack(connectionId).lastFeedAt = atMs;
}

export function capitalFeedAgeMs(connectionId: number): number | null {
  const t = track.get(connectionId);
  if (!t?.lastFeedAt) return null;
  return Date.now() - t.lastFeedAt;
}

export function isCapitalFeedStale(
  connectionId: number,
  maxAgeMs = DEFAULT_STALE_FEED_MS
): boolean {
  const age = capitalFeedAgeMs(connectionId);
  if (age == null) return false;
  return age > maxAgeMs;
}

export function getCapitalSessionHealth(connectionId: number): CapitalSessionHealth {
  const t = track.get(connectionId);
  const now = Date.now();
  if (!t) {
    return {
      connection_id: connectionId,
      level: 'WARNING',
      code: DecisionCodes.ERROR_SESSION,
      detail: 'No Capital session activity yet',
      has_cst: false,
      has_security_token: false,
      expires_in_ms: null,
      last_ok_at: null,
      last_error_at: null,
      last_error: null,
      retry_count: 0,
      feed_age_ms: null,
      rate_limited_until: null,
    };
  }

  const feedAge = t.lastFeedAt != null ? now - t.lastFeedAt : null;
  const expiresIn = t.expiresAt != null ? t.expiresAt - now : null;
  const rateUntil =
    t.cooldownUntil != null && t.cooldownUntil > now
      ? new Date(t.cooldownUntil).toISOString()
      : null;

  if (rateUntil) {
    return {
      connection_id: connectionId,
      level: 'WARNING',
      code: DecisionCodes.RATE_LIMITED,
      detail: t.lastError || 'Capital rate-limit cooldown',
      has_cst: t.hasCst,
      has_security_token: t.hasSec,
      expires_in_ms: expiresIn,
      last_ok_at: t.lastOkAt ? new Date(t.lastOkAt).toISOString() : null,
      last_error_at: t.lastErrorAt ? new Date(t.lastErrorAt).toISOString() : null,
      last_error: t.lastError,
      retry_count: t.retryCount,
      feed_age_ms: feedAge,
      rate_limited_until: rateUntil,
    };
  }

  if (t.lastError && (!t.lastOkAt || (t.lastErrorAt || 0) > t.lastOkAt)) {
    const parsed = parseCapitalBrokerError({ status: 0, detail: t.lastError });
    const level: CapitalSessionHealthLevel =
      parsed.code === DecisionCodes.SESSION_EXPIRED ? 'CRITICAL' : 'ERROR';
    return {
      connection_id: connectionId,
      level,
      code: parsed.code,
      detail: t.lastError,
      has_cst: t.hasCst,
      has_security_token: t.hasSec,
      expires_in_ms: expiresIn,
      last_ok_at: t.lastOkAt ? new Date(t.lastOkAt).toISOString() : null,
      last_error_at: t.lastErrorAt ? new Date(t.lastErrorAt).toISOString() : null,
      last_error: t.lastError,
      retry_count: t.retryCount,
      feed_age_ms: feedAge,
      rate_limited_until: null,
    };
  }

  if (feedAge != null && feedAge > DEFAULT_STALE_FEED_MS) {
    return {
      connection_id: connectionId,
      level: 'WARNING',
      code: DecisionCodes.STALE_PRICE,
      detail: `Feed age ${Math.round(feedAge / 1000)}s`,
      has_cst: t.hasCst,
      has_security_token: t.hasSec,
      expires_in_ms: expiresIn,
      last_ok_at: t.lastOkAt ? new Date(t.lastOkAt).toISOString() : null,
      last_error_at: t.lastErrorAt ? new Date(t.lastErrorAt).toISOString() : null,
      last_error: t.lastError,
      retry_count: t.retryCount,
      feed_age_ms: feedAge,
      rate_limited_until: null,
    };
  }

  if (expiresIn != null && expiresIn < REFRESH_BEFORE_MS) {
    return {
      connection_id: connectionId,
      level: 'WARNING',
      code: DecisionCodes.SESSION_EXPIRED,
      detail: `Session refresh due in ${Math.max(0, Math.round(expiresIn / 1000))}s`,
      has_cst: t.hasCst,
      has_security_token: t.hasSec,
      expires_in_ms: expiresIn,
      last_ok_at: t.lastOkAt ? new Date(t.lastOkAt).toISOString() : null,
      last_error_at: t.lastErrorAt ? new Date(t.lastErrorAt).toISOString() : null,
      last_error: t.lastError,
      retry_count: t.retryCount,
      feed_age_ms: feedAge,
      rate_limited_until: null,
    };
  }

  return {
    connection_id: connectionId,
    level: t.hasCst && t.hasSec ? 'OK' : 'WARNING',
    code: 'OK',
    detail: t.hasCst && t.hasSec ? 'Capital session live' : 'Session tokens incomplete',
    has_cst: t.hasCst,
    has_security_token: t.hasSec,
    expires_in_ms: expiresIn,
    last_ok_at: t.lastOkAt ? new Date(t.lastOkAt).toISOString() : null,
    last_error_at: t.lastErrorAt ? new Date(t.lastErrorAt).toISOString() : null,
    last_error: t.lastError,
    retry_count: t.retryCount,
    feed_age_ms: feedAge,
    rate_limited_until: null,
  };
}

export type CapitalCreds = {
  environment: string;
  apiKey: string;
  identifier: string;
  password: string;
  connectionId: number;
  capitalAccountId?: string | null;
};

/** Acquire session; force refresh when near expiry or after invalidate. */
export async function ensureCapitalSession(
  creds: CapitalCreds,
  opts?: { forceRefresh?: boolean }
): Promise<{ ok: true; session: CapitalSession } | { ok: false; result: CapitalComSessionResult }> {
  const t = ensureTrack(creds.connectionId);
  const now = Date.now();
  if (t.cooldownUntil && t.cooldownUntil > now) {
    const waitSec = Math.ceil((t.cooldownUntil - now) / 1000);
    return {
      ok: false,
      result: {
        ok: false,
        status: 429,
        errorCode: 'error.too-many.requests',
        detail: `Capital rate-limit cooldown ${waitSec}s`,
      },
    };
  }

  if (opts?.forceRefresh) {
    invalidateCapitalSession(creds.connectionId);
  } else if (t.expiresAt != null && t.expiresAt - now < REFRESH_BEFORE_MS) {
    invalidateCapitalSession(creds.connectionId);
  }

  const opened = await acquireCapitalSession({
    environment: creds.environment,
    apiKey: creds.apiKey,
    identifier: creds.identifier,
    password: creds.password,
    connectionId: creds.connectionId,
    capitalAccountId: creds.capitalAccountId,
  });

  if (!opened.ok) {
    const parsed = parseCapitalBrokerError({
      status: opened.result.status,
      detail: opened.result.detail,
      json: { errorCode: opened.result.errorCode },
    });
    recordCapitalSessionError(
      creds.connectionId,
      opened.result.detail,
      parsed.code === DecisionCodes.RATE_LIMITED ? { rateLimitMs: 120_000 } : undefined
    );
    return opened;
  }

  recordCapitalSessionOk(creds.connectionId, opened.session);
  return opened;
}

/**
 * Run Capital API work; on 401/SESSION_EXPIRED invalidate once and retry.
 * Never invents credentials — caller supplies them.
 */
export async function withCapitalAuthRetry<T>(
  creds: CapitalCreds,
  fn: (session: CapitalSession) => Promise<T>,
  isAuthFailure?: (err: unknown, result?: T) => boolean
): Promise<T> {
  const first = await ensureCapitalSession(creds);
  if (!first.ok) {
    throw new Error(first.result.detail);
  }

  try {
    const result = await fn(first.session);
    if (isAuthFailure?.(null, result)) {
      invalidateCapitalSession(creds.connectionId);
      recordCapitalSessionError(creds.connectionId, 'Auth failure — refreshing session');
      const second = await ensureCapitalSession(creds, { forceRefresh: true });
      if (!second.ok) throw new Error(second.result.detail);
      return await fn(second.session);
    }
    recordCapitalSessionOk(creds.connectionId, first.session);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const parsed = parseCapitalBrokerError({ status: 0, detail: msg });
    if (
      parsed.code === DecisionCodes.SESSION_EXPIRED ||
      isAuthFailure?.(err) ||
      /401|unauthor|expired/i.test(msg)
    ) {
      invalidateCapitalSession(creds.connectionId);
      recordCapitalSessionError(creds.connectionId, msg);
      const second = await ensureCapitalSession(creds, { forceRefresh: true });
      if (!second.ok) throw new Error(second.result.detail);
      return await fn(second.session);
    }
    recordCapitalSessionError(creds.connectionId, msg);
    throw err;
  }
}

/** Keepalive: light GET /accounts; refresh on failure. */
export async function capitalSessionKeepalive(creds: CapitalCreds): Promise<{
  ok: boolean;
  detail: string;
}> {
  try {
    const opened = await ensureCapitalSession(creds);
    if (!opened.ok) return { ok: false, detail: opened.result.detail };
    const res = await opened.session.get('/api/v1/accounts');
    if (res.status === 401) {
      invalidateCapitalSession(creds.connectionId);
      const again = await ensureCapitalSession(creds, { forceRefresh: true });
      if (!again.ok) return { ok: false, detail: again.result.detail };
      recordCapitalSessionOk(creds.connectionId, again.session);
      return { ok: true, detail: 'Session refreshed after 401 keepalive' };
    }
    if (!res.ok) {
      const parsed = parseCapitalBrokerError({
        status: res.status,
        json: res.json,
        text: res.text,
      });
      recordCapitalSessionError(creds.connectionId, parsed.message);
      return { ok: false, detail: parsed.message };
    }
    recordCapitalSessionOk(creds.connectionId, opened.session);
    return { ok: true, detail: 'Keepalive OK' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordCapitalSessionError(creds.connectionId, msg);
    return { ok: false, detail: msg };
  }
}

/** Test helper — clear tracking state. */
export function _resetCapitalSessionManagerForTests(): void {
  track.clear();
}
