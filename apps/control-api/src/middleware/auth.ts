import { timingSafeEqual } from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { authorizePipelineRequest } from '../services/pipelineBridge.js';

/** GET/HEAD only — never mutate system state without admin token. */
const PUBLIC_GET_PATHS = new Set([
  '/health',
  '/api/system/status',
  '/api/system/mode',
]);

const PUBLIC_PREFIXES = [
  '/api/client-auth/',
  '/api/client/',
  '/ws/client',
];

const PLACEHOLDER_ADMIN = new Set(['', 'CHANGE_ME', 'CHANGE_ME_ADMIN_TOKEN']);

export function isAdminTokenConfigured(): boolean {
  const t = String(process.env.API_ADMIN_TOKEN || '').trim();
  return Boolean(t) && !PLACEHOLDER_ADMIN.has(t) && !t.startsWith('CHANGE_ME');
}

function allowInsecureDev(): boolean {
  return (
    process.env.ALLOW_INSECURE_DEV === 'true' &&
    process.env.NODE_ENV !== 'production'
  );
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Admin COMMAND desk is local (Vite :5173 → :3000). Cloudflare public panel
 * never proxies /api/clients — only client-auth/client/ws/client.
 * Without this, a fresh API_ADMIN_TOKEN + missing VITE_ADMIN_TOKEN makes the
 * desk show an empty client list (401 swallowed → []).
 */
export function isTrustedLocalDesk(request: FastifyRequest): boolean {
  const ip = String(request.ip || '')
    .trim()
    .replace(/^::ffff:/i, '');
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(ip)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(ip)) return true;
  return false;
}

/** Static client panel (GET / /assets /logo.svg) is public — not Vite, not admin. */
export function isPublicUnauthedPath(method: string, urlPath: string): boolean {
  const path = urlPath.split('?')[0] || '/';
  if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p))) return true;
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') {
    if (PUBLIC_GET_PATHS.has(path)) return true;
    if (!path.startsWith('/api') && !path.startsWith('/ws')) {
      return true;
    }
  }
  return false;
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const path = request.url.split('?')[0];

  // INTERNAL SERVICE — not client session, not admin browser identity
  if (path === '/api/pipeline' || path.startsWith('/api/pipeline/')) {
    if (authorizePipelineRequest(request.headers as Record<string, unknown>)) return;
    reply.code(401).send({
      error: 'Unauthorized',
      message: 'Pipeline requires x-pipeline-token',
    });
    return;
  }

  if (isPublicUnauthedPath(request.method, path)) return;

  // Local / LAN admin desk — do not blank CLIENTS when Vite env lags behind .env
  if (isTrustedLocalDesk(request)) return;

  if (!isAdminTokenConfigured()) {
    if (allowInsecureDev()) return;
    reply.code(401).send({
      error: 'API token not configured',
      message:
        'Set API_ADMIN_TOKEN in .env (not CHANGE_ME). Or ALLOW_INSECURE_DEV=true for local DX only.',
    });
    return;
  }

  const token = String(request.headers['x-admin-token'] || '').trim();
  const expected = String(process.env.API_ADMIN_TOKEN || '').trim();

  if (!token || !safeEqual(token, expected)) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
}
