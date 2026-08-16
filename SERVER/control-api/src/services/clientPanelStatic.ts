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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export function clientPanelDistDir(): string {
  const fromEnv = process.env.CLIENT_PANEL_DIST?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Prefer CLIENT desktop dist; optional env override
  return path.resolve(here, '../../../../CLIENT/desktop/dist');
}

function safeJoin(root: string, urlPath: string): string | null {
  const rel = decodeURIComponent(urlPath.split('?')[0] || '/');
  const candidate = path.resolve(root, '.' + (rel === '/' ? '/index.html' : rel));
  if (!candidate.startsWith(root)) return null;
  return candidate;
}

export async function registerClientPanelStatic(app: FastifyInstance): Promise<void> {
  const dist = clientPanelDistDir();

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const urlPath = request.url.split('?')[0] || '/';
    if (urlPath.startsWith('/api') || urlPath.startsWith('/ws')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({ error: 'Not found' });
    }

    reply.header('X-VS-Panel', 'control-api');

    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('Client web panel not built. On server: cd CLIENT/desktop && npm run build\n');
    }

    let file = safeJoin(dist, urlPath);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      file = path.join(dist, 'index.html');
    }
    const ext = path.extname(file).toLowerCase();
    return reply.type(MIME[ext] || 'application/octet-stream').send(fs.createReadStream(file));
  });
}
