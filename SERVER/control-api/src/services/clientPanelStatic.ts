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

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../..');
}

/** Operator TACTICAL DESK (ROBOT COMMAND). Never the VS CLIENT login. */
export function deskPanelDistDir(): string | null {
  const fromEnv = process.env.DESK_PANEL_DIST?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    return fs.existsSync(path.join(resolved, 'index.html')) ? resolved : null;
  }
  const desk = path.join(repoRoot(), 'ADMIN', 'desk', 'dist');
  return fs.existsSync(path.join(desk, 'index.html')) ? desk : null;
}

/** VS CLIENT login portal. Used for `/` — never for `/robot`. */
export function clientPanelDistDir(): string {
  const fromEnv = process.env.CLIENT_PANEL_DIST?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(repoRoot(), 'CLIENT', 'web', 'dist');
}

const OPERATOR_PREFIXES = [
  '/robot',
  '/feeds',
  '/orbit',
  '/brokers',
  '/account',
  '/market',
  '/trading',
  '/evidence',
  '/positions',
  '/clients',
  '/network',
  '/trades',
  '/system',
  '/logs',
  '/settings',
  '/client',
];

export function isOperatorDeskPath(urlPath: string): boolean {
  const p = urlPath.split('?')[0] || '/';
  return OPERATOR_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

function safeJoin(root: string, urlPath: string): string | null {
  const rel = decodeURIComponent(urlPath.split('?')[0] || '/');
  const candidate = path.resolve(root, `.${rel === '/' ? '/index.html' : rel}`);
  if (!candidate.startsWith(root)) return null;
  return candidate;
}

function sendFile(reply: FastifyReply, file: string, panel: string) {
  const ext = path.extname(file).toLowerCase();
  reply.header('X-VS-Panel', panel);
  if (ext === '.html') reply.header('Cache-Control', 'no-store');
  return reply.type(MIME[ext] || 'application/octet-stream').send(fs.createReadStream(file));
}

function fileIfExists(root: string, urlPath: string): string | null {
  const file = safeJoin(root, urlPath);
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  return null;
}

export async function registerClientPanelStatic(app: FastifyInstance): Promise<void> {
  // Resolve dist per request. A process that booted before ADMIN/desk was built
  // must still serve TACTICAL DESK on /robot once dist/index.html exists.
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const urlPath = request.url.split('?')[0] || '/';
    if (urlPath.startsWith('/api') || urlPath.startsWith('/ws')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({ error: 'Not found' });
    }

    const desk = deskPanelDistDir();
    const client = clientPanelDistDir();

    if (isOperatorDeskPath(urlPath)) {
      if (!desk) {
        return reply
          .code(503)
          .type('text/plain; charset=utf-8')
          .header('X-VS-Panel', 'tactical-desk')
          .send('Tactical desk not built. START_MSI.bat / PALAID.bat builds ADMIN/desk\n');
      }
      const file = fileIfExists(desk, urlPath) || path.join(desk, 'index.html');
      return sendFile(reply, file, 'tactical-desk');
    }

    const looksLikeFile = /\.[A-Za-z0-9]+$/.test(urlPath);
    if (looksLikeFile) {
      const fromDesk = desk ? fileIfExists(desk, urlPath) : null;
      const fromClient = fileIfExists(client, urlPath);
      if (fromDesk) return sendFile(reply, fromDesk, 'tactical-desk');
      if (fromClient) return sendFile(reply, fromClient, 'control-api');
    }

    if (fs.existsSync(path.join(client, 'index.html'))) {
      return sendFile(reply, path.join(client, 'index.html'), 'control-api');
    }

    return reply
      .code(503)
      .type('text/plain; charset=utf-8')
      .send('Client web not built. START_MSI.bat builds CLIENT/web\n');
  });
}
