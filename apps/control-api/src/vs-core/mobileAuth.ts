/**
 * Mobile Control API auth — token/session, expiry, refresh/revocation, rate limit.
 * Capital credentials never leave VS CORE.
 */

import { createHash, randomBytes } from 'crypto';

export type MobileSession = {
  session_id: string;
  client_id: number;
  token_hash: string;
  refresh_hash: string;
  device_id: string;
  expires_at: number;
  refresh_expires_at: number;
  revoked: boolean;
  created_at: number;
  last_seen_at: number;
};

export type AuthResult =
  | { ok: true; token: string; refresh_token: string; expires_at: number; session_id: string }
  | { ok: false; code: string; reason: string };

const TOKEN_TTL_MS = 1000 * 60 * 60; // 1h
const REFRESH_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 60_000;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class MobileAuthService {
  private sessions = new Map<string, MobileSession>();
  private byTokenHash = new Map<string, string>();
  private loginAttempts = new Map<string, number[]>();
  /** client_id → password hash (scrypt-style opaque string from outside). */
  private passwordVerifier: (clientId: number, password: string) => Promise<boolean>;

  constructor(passwordVerifier: (clientId: number, password: string) => Promise<boolean>) {
    this.passwordVerifier = passwordVerifier;
  }

  private rateLimit(key: string): boolean {
    const now = Date.now();
    const arr = (this.loginAttempts.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (arr.length >= MAX_LOGIN_ATTEMPTS) {
      this.loginAttempts.set(key, arr);
      return false;
    }
    arr.push(now);
    this.loginAttempts.set(key, arr);
    return true;
  }

  async login(input: {
    client_id: number;
    password: string;
    device_id: string;
    ip?: string;
  }): Promise<AuthResult> {
    const rlKey = `${input.client_id}:${input.ip || 'na'}`;
    if (!this.rateLimit(rlKey)) {
      return { ok: false, code: 'RATE_LIMITED', reason: 'Too many login attempts' };
    }
    const ok = await this.passwordVerifier(input.client_id, input.password);
    if (!ok) {
      return { ok: false, code: 'AUTH_FAILED', reason: 'Invalid credentials' };
    }
    const token = randomBytes(32).toString('hex');
    const refresh = randomBytes(32).toString('hex');
    const session_id = randomBytes(16).toString('hex');
    const now = Date.now();
    const session: MobileSession = {
      session_id,
      client_id: input.client_id,
      token_hash: hash(token),
      refresh_hash: hash(refresh),
      device_id: input.device_id,
      expires_at: now + TOKEN_TTL_MS,
      refresh_expires_at: now + REFRESH_TTL_MS,
      revoked: false,
      created_at: now,
      last_seen_at: now,
    };
    this.sessions.set(session_id, session);
    this.byTokenHash.set(session.token_hash, session_id);
    return {
      ok: true,
      token,
      refresh_token: refresh,
      expires_at: session.expires_at,
      session_id,
    };
  }

  resolve(token: string | null | undefined): MobileSession | null {
    if (!token) return null;
    const sid = this.byTokenHash.get(hash(token));
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s || s.revoked) return null;
    if (Date.now() > s.expires_at) return null;
    s.last_seen_at = Date.now();
    return s;
  }

  refresh(refreshToken: string): AuthResult {
    const rh = hash(refreshToken);
    const s = [...this.sessions.values()].find((x) => x.refresh_hash === rh);
    if (!s || s.revoked) {
      return { ok: false, code: 'AUTH_FAILED', reason: 'Invalid refresh token' };
    }
    if (Date.now() > s.refresh_expires_at) {
      return { ok: false, code: 'TOKEN_EXPIRED', reason: 'Refresh token expired' };
    }
    // rotate
    this.byTokenHash.delete(s.token_hash);
    const token = randomBytes(32).toString('hex');
    const refresh = randomBytes(32).toString('hex');
    s.token_hash = hash(token);
    s.refresh_hash = hash(refresh);
    s.expires_at = Date.now() + TOKEN_TTL_MS;
    s.last_seen_at = Date.now();
    this.byTokenHash.set(s.token_hash, s.session_id);
    return {
      ok: true,
      token,
      refresh_token: refresh,
      expires_at: s.expires_at,
      session_id: s.session_id,
    };
  }

  revoke(token: string): boolean {
    const s = this.resolve(token);
    if (!s) {
      // maybe expired — still try hash
      const sid = this.byTokenHash.get(hash(token));
      if (!sid) return false;
      const sess = this.sessions.get(sid);
      if (!sess) return false;
      sess.revoked = true;
      this.byTokenHash.delete(sess.token_hash);
      return true;
    }
    s.revoked = true;
    this.byTokenHash.delete(s.token_hash);
    return true;
  }

  /** Enforce client isolation — Client A must not access Client B. */
  assertClientAccess(session: MobileSession, targetClientId: number): boolean {
    return session.client_id === targetClientId;
  }
}
