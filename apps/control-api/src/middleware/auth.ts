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
