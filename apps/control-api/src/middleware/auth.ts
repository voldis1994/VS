import { FastifyRequest, FastifyReply } from 'fastify';
import { authorizePipelineRequest } from '../services/pipelineBridge.js';

const PUBLIC_PATHS = [
  '/health',
  '/api/system/status',
  '/api/system/mode',
  '/api/client-auth/',
  '/api/client/',
  '/ws/client',
];

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

  if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(p))) return;

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
