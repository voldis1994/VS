import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function adminPanelDir(): string {
  const fromEnv = process.env.ADMIN_PANEL_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../ADMIN/web');
}

function safeFile(root: string, name: string): string | null {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  const candidate = path.resolve(root, name);
  if (!candidate.startsWith(root)) return null;
  return candidate;
}

export async function registerAdminPanelStatic(app: FastifyInstance): Promise<void> {
  const root = adminPanelDir();

  const sendIndex = (_request: FastifyRequest, reply: FastifyReply) => {
    const file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('Admin web panel missing (ADMIN/web/index.html)\n');
    }
    reply.header('X-VS-Panel', 'admin');
    reply.header('Cache-Control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(fs.createReadStream(file));
  };

  app.get('/admin', async (_req, reply) => reply.redirect('/admin/'));
  app.get('/admin/', sendIndex);

  app.get('/admin/:file', async (request, reply) => {
    const name = String((request.params as { file?: string }).file || '');
    const file = safeFile(root, name);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return sendIndex(request, reply);
    }
    const ext = path.extname(file).toLowerCase();
    reply.header('X-VS-Panel', 'admin');
    reply.header('Cache-Control', 'no-store');
    return reply.type(MIME[ext] || 'application/octet-stream').send(fs.createReadStream(file));
  });
}
