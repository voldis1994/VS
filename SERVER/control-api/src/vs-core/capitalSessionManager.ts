/**
 * Capital Session Manager — per-client isolated Capital.com sessions.
 * Credentials never leave VS CORE. Mobile never receives secrets.
 */

export type CapitalEnv = 'demo' | 'live';

export type CapitalCredentials = {
  api_key: string;
  identifier: string;
  password: string;
  environment: CapitalEnv;
};

export type SessionTokens = {
  cst: string;
  security_token: string;
  account_id?: string | null;
  obtained_at: number;
  expires_at: number;
};

export type SessionHealth =
  | 'CONNECTED'
  | 'CONNECTING'
  | 'EXPIRED'
  | 'RATE_LIMITED'
  | 'ERROR'
  | 'DISCONNECTED'
  | 'UNVERIFIED';

export type ManagedSession = {
  client_id: number;
  account_id: number;
  connection_id: number;
  environment: CapitalEnv;
  health: SessionHealth;
  tokens: SessionTokens | null;
  last_error: string | null;
  last_verified_at: number | null;
  reconnect_attempts: number;
};

export type SessionLoginFn = (creds: CapitalCredentials) => Promise<{
  ok: boolean;
  status: number;
  cst?: string;
  security_token?: string;
  account_id?: string | null;
  detail: string;
}>;

export type SessionProbeFn = (tokens: SessionTokens, env: CapitalEnv) => Promise<{
  ok: boolean;
  status: number;
  detail: string;
}>;

const DEFAULT_TTL_MS = 9 * 60 * 1000; // refresh before typical Capital session expiry
const MAX_RECONNECT = 5;

export class CapitalSessionManager {
  private sessions = new Map<string, ManagedSession>();
  private creds = new Map<string, CapitalCredentials>();
  private loginFn: SessionLoginFn;
  private probeFn: SessionProbeFn;
  private now: () => number;

  constructor(deps: {
    login: SessionLoginFn;
    probe: SessionProbeFn;
    now?: () => number;
  }) {
    this.loginFn = deps.login;
    this.probeFn = deps.probe;
    this.now = deps.now || (() => Date.now());
  }

  private key(clientId: number, accountId: number): string {
    return `${clientId}:${accountId}`;
  }

  /** Store credentials server-side only — never serialize to mobile responses. */
  setCredentials(
    clientId: number,
    accountId: number,
    connectionId: number,
    creds: CapitalCredentials
  ): void {
    const k = this.key(clientId, accountId);
    this.creds.set(k, { ...creds });
    const existing = this.sessions.get(k);
    this.sessions.set(k, {
      client_id: clientId,
      account_id: accountId,
      connection_id: connectionId,
      environment: creds.environment,
      health: existing?.health || 'DISCONNECTED',
      tokens: existing?.tokens || null,
      last_error: existing?.last_error || null,
      last_verified_at: existing?.last_verified_at || null,
      reconnect_attempts: existing?.reconnect_attempts || 0,
    });
  }

  getPublicState(clientId: number, accountId: number): Record<string, unknown> | null {
    const s = this.sessions.get(this.key(clientId, accountId));
    if (!s) return null;
    // Never spread ManagedSession — tokens/passwords/keys must never appear here
    return {
      connected: s.health === 'CONNECTED',
      authenticated: s.health === 'CONNECTED' && s.tokens != null,
      health: s.health,
      error_code: s.last_error,
      account_id: s.account_id,
      connection_id: s.connection_id,
      environment: s.environment,
      last_successful_operation_at: s.last_verified_at,
      session_age_ms: s.last_verified_at != null ? Date.now() - s.last_verified_at : null,
      has_credentials: this.creds.has(this.key(clientId, accountId)),
      secrets_exposed: false,
    };
  }

  /** Client A must not read Client B session. */
  assertIsolation(requestingClientId: number, targetClientId: number): boolean {
    return requestingClientId === targetClientId;
  }

  async connect(clientId: number, accountId: number): Promise<ManagedSession> {
    const k = this.key(clientId, accountId);
    const creds = this.creds.get(k);
    let s = this.sessions.get(k);
    if (!creds || !s) {
      throw new Error('CAPITAL_CREDENTIALS_MISSING');
    }
    s = { ...s, health: 'CONNECTING', last_error: null };
    this.sessions.set(k, s);

    const res = await this.loginFn(creds);
    if (res.status === 429) {
      s = {
        ...s,
        health: 'RATE_LIMITED',
        last_error: res.detail,
        reconnect_attempts: s.reconnect_attempts + 1,
      };
      this.sessions.set(k, s);
      return s;
    }
    if (!res.ok || !res.cst || !res.security_token) {
      s = {
        ...s,
        health: 'ERROR',
        tokens: null,
        last_error: res.detail,
        reconnect_attempts: s.reconnect_attempts + 1,
      };
      this.sessions.set(k, s);
      return s;
    }

    const now = this.now();
    s = {
      ...s,
      health: 'CONNECTED',
      tokens: {
        cst: res.cst,
        security_token: res.security_token,
        account_id: res.account_id ?? null,
        obtained_at: now,
        expires_at: now + DEFAULT_TTL_MS,
      },
      last_error: null,
      last_verified_at: now,
      reconnect_attempts: 0,
    };
    this.sessions.set(k, s);
    return s;
  }

  async verify(clientId: number, accountId: number): Promise<ManagedSession> {
    const k = this.key(clientId, accountId);
    let s = this.sessions.get(k);
    if (!s) throw new Error('SESSION_NOT_FOUND');
    if (!s.tokens) {
      s = { ...s, health: 'UNVERIFIED', last_error: 'no tokens' };
      this.sessions.set(k, s);
      return s;
    }
    if (this.now() >= s.tokens.expires_at) {
      s = { ...s, health: 'EXPIRED', last_error: 'session TTL exceeded' };
      this.sessions.set(k, s);
      return this.refresh(clientId, accountId);
    }
    const probe = await this.probeFn(s.tokens, s.environment);
    if (probe.status === 401 || probe.status === 403) {
      s = { ...s, health: 'EXPIRED', last_error: probe.detail };
      this.sessions.set(k, s);
      return this.refresh(clientId, accountId);
    }
    if (probe.status === 429) {
      s = { ...s, health: 'RATE_LIMITED', last_error: probe.detail };
      this.sessions.set(k, s);
      return s;
    }
    if (!probe.ok) {
      s = { ...s, health: 'ERROR', last_error: probe.detail };
      this.sessions.set(k, s);
      return s;
    }
    s = {
      ...s,
      health: 'CONNECTED',
      last_verified_at: this.now(),
      last_error: null,
    };
    this.sessions.set(k, s);
    return s;
  }

  async refresh(clientId: number, accountId: number): Promise<ManagedSession> {
    const k = this.key(clientId, accountId);
    const s = this.sessions.get(k);
    if (!s) throw new Error('SESSION_NOT_FOUND');
    if (s.reconnect_attempts >= MAX_RECONNECT) {
      const failed: ManagedSession = {
        ...s,
        health: 'ERROR',
        last_error: 'CRITICAL_SESSION_RECONNECT_LOOP',
      };
      this.sessions.set(k, failed);
      return failed;
    }
    return this.connect(clientId, accountId);
  }

  isTradingAllowed(clientId: number, accountId: number): boolean {
    const s = this.sessions.get(this.key(clientId, accountId));
    return s?.health === 'CONNECTED' && s.tokens != null && s.last_verified_at != null;
  }

  /** Strip secrets — safe for logs / mobile. */
  static redact(s: ManagedSession): Record<string, unknown> {
    return {
      client_id: s.client_id,
      account_id: s.account_id,
      connection_id: s.connection_id,
      environment: s.environment,
      health: s.health,
      last_error: s.last_error,
      last_verified_at: s.last_verified_at,
      reconnect_attempts: s.reconnect_attempts,
      has_tokens: s.tokens != null,
    };
  }
}
