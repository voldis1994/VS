import { FastifyRequest, FastifyReply } from 'fastify';
import { authorizePipelineRequest } from '../services/pipelineBridge.js';

const PUBLIC_PATHS = [
  '/health',
  '/api/system/health',
  '/api/client-auth/',
  '/api/client/',
  '/ws/client',
];

/** Explicit public /api/v1 endpoints only — not the whole prefix. */
const PUBLIC_API_V1 = new Set([
  '/api/v1/login',
  '/api/v1/refresh',
  // i3 physical console monitor — localhost-only enforced in adminAgent handlers
  '/api/v1/server/monitor/console',
  '/api/v1/server/monitor/console/text',
  // Home LAN bootstrap for MSI ADMIN (token only when VS_LAN_TRUST_ADMIN=1 + private IP)
  '/api/v1/admin/lan-bootstrap',
]);

function lanTrustEnabled(): boolean {
  const v = String(process.env.VS_LAN_TRUST_ADMIN || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function isPrivateIp(ip: string): boolean {
  const n = ip.replace(/^::ffff:/, '');
  if (n === '127.0.0.1' || n === '::1') return true;
  if (/^10\./.test(n)) return true;
  if (/^192\.168\./.test(n)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(n)) return true;
  return false;
}

function requestFromPrivateLan(request: FastifyRequest): boolean {
  const candidates = [
    request.ip,
    ...(Array.isArray(request.ips) ? request.ips : []),
    request.socket?.remoteAddress,
  ].filter(Boolean) as string[];
  return candidates.some(isPrivateIp);
}

/** Static client panel (GET / /assets /logo.svg) is public — not Vite, not admin. */
export function isPublicUnauthedPath(method: string, urlPath: string): boolean {
  const path = urlPath.split('?')[0] || '/';
  if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(p))) return true;
  if (PUBLIC_API_V1.has(path)) return true;
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

  // VS Private Network device channel — application session auth inside networkApi
  // (WireGuard ≠ authorization). Do not require x-admin-token here.
  if (path === '/api/v1/network' || path.startsWith('/api/v1/network/')) return;

  // Home appliance: MSI on LAN may use a narrow set of READ-ONLY monitoring
  // endpoints without copying the token first.  State-changing routes
  // (trading start/stop, kill-switch, lot-size writes, etc.) always require
  // a valid x-admin-token regardless of source IP.
  const LAN_TRUST_READONLY_PATHS = new Set([
    '/api/v1/admin/ping',
    '/api/v1/admin/health',
    '/api/v1/admin/snapshot',
    '/api/v1/admin/tui',
    '/api/v1/server/monitor',
    '/api/v1/server/monitor/text',
    '/api/v1/broker/health',
    '/api/v1/presence',
    '/api/v1/system/status',
    '/api/v1/system/supervisor',
    '/api/v1/incidents',
    '/api/v1/market',
    '/api/system/health',
    '/api/system/money-path',
  ]);
  if (
    lanTrustEnabled() &&
    requestFromPrivateLan(request) &&
    request.method === 'GET' &&
    LAN_TRUST_READONLY_PATHS.has(path)
  ) {
    return;
  }

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
