import { createHash, randomBytes } from 'crypto';
import { pool } from '../db/pool.js';

export const CLIENT_SESSION_COOKIE = 'vs_client_session';
export const CLIENT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createRawSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export async function createClientSession(clientId: number): Promise<{
  token: string;
  expires_at: Date;
}> {
  const token = createRawSessionToken();
  const tokenHash = hashSessionToken(token);
  const expires = new Date(Date.now() + CLIENT_SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO client_sessions (client_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [clientId, tokenHash, expires.toISOString()]
  );
  return { token, expires_at: expires };
}

export async function revokeClientSession(token: string): Promise<void> {
  const tokenHash = hashSessionToken(token);
  await pool.query('DELETE FROM client_sessions WHERE token_hash = $1', [tokenHash]);
}

export async function revokeAllClientSessions(clientId: number): Promise<void> {
  await pool.query('DELETE FROM client_sessions WHERE client_id = $1', [clientId]);
}

export type ResolvedClientSession = {
  session_id: number;
  client_id: number;
  client_name: string;
  client_enabled: boolean;
  access_enabled: boolean;
};

export async function resolveClientSession(
  token: string | null | undefined
): Promise<ResolvedClientSession | null> {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const { rows } = await pool.query(
    `SELECT cs.id as session_id, cs.client_id, cs.expires_at,
            c.name as client_name, c.enabled as client_enabled, c.access_enabled
     FROM client_sessions cs
     JOIN clients c ON c.id = cs.client_id
     WHERE cs.token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );
  if (!rows.length) return null;
  const row = rows[0] as {
    session_id: number;
    client_id: number;
    expires_at: Date | string;
    client_name: string;
    client_enabled: boolean;
    access_enabled: boolean;
  };
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await pool.query('DELETE FROM client_sessions WHERE id = $1', [row.session_id]);
    return null;
  }
  await pool.query(
    `UPDATE client_sessions SET last_seen_at = NOW() WHERE id = $1`,
    [row.session_id]
  );
  await pool.query(`UPDATE clients SET last_seen_at = NOW() WHERE id = $1`, [row.client_id]);
  return {
    session_id: row.session_id,
    client_id: row.client_id,
    client_name: row.client_name,
    client_enabled: row.client_enabled,
    access_enabled: Boolean(row.access_enabled),
  };
}

export function parseCookieHeader(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function extractClientToken(request: {
  headers: Record<string, unknown>;
}): string | null {
  const auth = String(request.headers['authorization'] || '');
  if (auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const hdr = request.headers['x-client-token'];
  if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
  return parseCookieHeader(
    typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
    CLIENT_SESSION_COOKIE
  );
}

export function sessionCookieOptions(expires: Date): string {
  const secure = process.env.NODE_ENV === 'production' || process.env.CLIENT_COOKIE_SECURE === 'true';
  const parts = [
    `${CLIENT_SESSION_COOKIE}=`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Expires=${expires.toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
