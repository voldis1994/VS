import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';
import { verifyAccessCode } from '../security/accessCode.js';
import {
  CLIENT_SESSION_COOKIE,
  createClientSession,
  extractClientToken,
  resolveClientSession,
  revokeClientSession,
  sessionCookieOptions,
  type ResolvedClientSession,
} from '../security/clientSession.js';
import { logAudit } from '../services/audit.js';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

async function countRecentFailures(ip: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM client_login_attempts
     WHERE ip = $1 AND success = false AND attempted_at > NOW() - INTERVAL '15 minutes'`,
    [ip]
  );
  return rows[0]?.n ?? 0;
}

async function recordAttempt(ip: string, success: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO client_login_attempts (ip, success) VALUES ($1, $2)`,
    [ip, success]
  );
}

function clientIp(request: FastifyRequest): string {
  const xf = request.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0]!.trim();
  return request.ip || 'unknown';
}

export function setClientSessionCookie(reply: FastifyReply, token: string, expires: Date): void {
  const base = sessionCookieOptions(expires);
  // inject token after cookie name=
  const cookie = base.replace(`${CLIENT_SESSION_COOKIE}=`, `${CLIENT_SESSION_COOKIE}=${encodeURIComponent(token)}`);
  reply.header('Set-Cookie', cookie);
}

export function clearClientSessionCookie(reply: FastifyReply): void {
  const secure = process.env.NODE_ENV === 'production' || process.env.CLIENT_COOKIE_SECURE === 'true';
  let cookie = `${CLIENT_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  if (secure) cookie += '; Secure';
  reply.header('Set-Cookie', cookie);
}

export async function requireClientSession(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<ResolvedClientSession | null> {
  const token = extractClientToken(request);
  const session = await resolveClientSession(token);
  if (!session) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Client session required' });
    return null;
  }
  if (!session.client_enabled || !session.access_enabled) {
    reply.code(403).send({ error: 'Forbidden', message: 'Client access disabled' });
    return null;
  }
  return session;
}

export async function registerClientAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/client-auth/login', async (request, reply) => {
    const body = (request.body || {}) as { access_code?: string };
    const code = String(body.access_code || '').trim();
    const ip = clientIp(request);

    const failures = await countRecentFailures(ip);
    if (failures >= LOGIN_MAX_ATTEMPTS) {
      return reply.code(429).send({
        error: 'Too many login attempts',
        message: `Rate limited. Try again in ${LOGIN_WINDOW_MS / 60000} minutes.`,
      });
    }

    if (!code) {
      await recordAttempt(ip, false);
      return reply.code(400).send({ error: 'access_code required', message: 'access_code required' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, enabled, access_enabled, access_code_hash
       FROM clients
       WHERE access_code_hash IS NOT NULL`
    );

    let matched: { id: number; name: string; enabled: boolean; access_enabled: boolean } | null =
      null;
    for (const row of rows) {
      if (verifyAccessCode(code, row.access_code_hash as string)) {
        matched = {
          id: row.id as number,
          name: row.name as string,
          enabled: Boolean(row.enabled),
          access_enabled: Boolean(row.access_enabled),
        };
        break;
      }
    }

    if (!matched) {
      await recordAttempt(ip, false);
      return reply.code(401).send({ error: 'Invalid access code', message: 'Invalid access code' });
    }
    if (!matched.enabled || !matched.access_enabled) {
      await recordAttempt(ip, false);
      return reply.code(403).send({
        error: 'Client access disabled',
        message: 'Client access disabled',
      });
    }

    await recordAttempt(ip, true);
    const { token, expires_at } = await createClientSession(matched.id);
    setClientSessionCookie(reply, token, expires_at);
    await pool.query(`UPDATE clients SET last_seen_at = NOW() WHERE id = $1`, [matched.id]);
    await logAudit('client', 'client_login', 'client', String(matched.id), null, {
      ip,
    });

    return {
      success: true,
      token,
      expires_at: expires_at.toISOString(),
      client: { id: matched.id, name: matched.name },
    };
  });

  app.post('/api/client-auth/logout', async (request, reply) => {
    const token = extractClientToken(request);
    if (token) await revokeClientSession(token);
    clearClientSessionCookie(reply);
    return { success: true };
  });

  app.get('/api/client-auth/me', async (request, reply) => {
    const session = await requireClientSession(request, reply);
    if (!session) return;
    return {
      client_id: session.client_id,
      name: session.client_name,
    };
  });
}
