import { FastifyRequest, FastifyReply } from 'fastify';
import { authorizePipelineRequest } from '../services/pipelineBridge.js';

const PUBLIC_PATHS = [
  '/health',
  '/api/system/status',
  '/api/system/mode',
  '/api/system/health',
  '/api/client-auth/',
  '/api/client/',
  '/ws/client',
];

/** Static client panel (GET / /assets /logo.svg) is public — not Vite, not admin. */
export function isPublicUnauthedPath(method: string, urlPath: string): boolean {
  const path = urlPath.split('?')[0] || '/';
  if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(p))) return true;
  const m = method.toUpperCase();
  if ((m === 'GET' || m === 'HEAD') && !path.startsWith('/api') && !path.startsWith('/ws')) {
    return true;
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

  const token = request.headers['x-admin-token'] as string | undefined;
  const expected = process.env.API_ADMIN_TOKEN;

  if (!expected || expected === 'CHANGE_ME_ADMIN_TOKEN') {
    if (process.env.NODE_ENV === 'production') {
      reply.code(401).send({ error: 'API token not configured' });
      return;
    }
    return;
  }

  if (token !== expected) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
}
