#!/usr/bin/env node
/**
 * Production local ADMIN UI runtime — static dist on 127.0.0.1:5188.
 * Not Vite dev. SPA fallback to index.html.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
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

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.VS_ADMIN_DIST
  ? path.resolve(process.env.VS_ADMIN_DIST)
  : path.resolve(here, '../desktop/dist');
const host = process.env.VS_ADMIN_UI_HOST || '127.0.0.1';
const port = Number(process.env.VS_ADMIN_UI_PORT || 5188);

function safeFile(urlPath) {
  const rel = decodeURIComponent((urlPath || '/').split('?')[0] || '/');
  const candidate = path.resolve(dist, '.' + (rel === '/' ? '/index.html' : rel));
  if (!candidate.startsWith(dist)) return null;
  return candidate;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  let file = safeFile(req.url);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    file = path.join(dist, 'index.html');
  }
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ADMIN dist missing — run npm run build in ADMIN/desktop\n');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  process.stdout.write(`VS ADMIN UI http://${host}:${port}/ dist=${dist}\n`);
});
