/**
 * Public Client Control Panel — port 18080.
 * Cloudflare talks ONLY to this Node server. Vite is never on this port.
 *
 * SECURITY: proxy allowlists client-panel routes only.
 * Admin / pipeline / trading / robot-desk must NEVER be reachable via the tunnel.
 */
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LISTEN_PORT = Number(process.env.CLIENT_PUBLIC_PORT || 18080);
const API_HOST = process.env.CONTROL_API_HOST || '127.0.0.1';
const API_PORT = Number(process.env.CONTROL_API_PORT || 3000);
const DIST = path.resolve(
  process.env.CLIENT_DIST || path.join(DIR, '..', 'apps', 'dashboard', 'dist-client'),
);
const PANEL = 'vs-public-18080';

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
  '.txt': 'text/plain; charset=utf-8',
};

/** Paths safe to expose on the Cloudflare / public panel port. */
export function isPublicClientProxyPath(url) {
  const p = (url || '/').split('?')[0] || '/';
  if (p === '/health') return true;
  if (p === '/api/client-auth' || p.startsWith('/api/client-auth/')) return true;
  if (p === '/api/client' || p.startsWith('/api/client/')) return true;
  if (p === '/ws/client' || p.startsWith('/ws/client')) return true;
  return false;
}

function panelHeaders(extra = {}) {
  return { 'X-VS-Panel': PANEL, 'Cache-Control': 'no-store', ...extra };
}

function proxyHeaders(req) {
  const headers = { ...req.headers };
  headers.host = `${API_HOST}:${API_PORT}`;
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = 'https';
  return headers;
}

function rejectProxy(res, code, msg) {
  res.writeHead(code, panelHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
  res.end(msg);
}

function proxyHttp(req, res) {
  const p = http.request(
    {
      hostname: API_HOST,
      port: API_PORT,
      path: req.url,
      method: req.method,
      headers: proxyHeaders(req),
    },
    (incoming) => {
      const out = { ...incoming.headers, 'x-vs-panel': PANEL };
      res.writeHead(incoming.statusCode || 502, out);
      incoming.pipe(res);
    },
  );
  p.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, panelHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    }
    res.end(`API nav pieejams (:${API_PORT}). Palaid VS.bat.\n${err.message}\n`);
  });
  req.pipe(p);
}

function proxyUpgrade(req, clientSocket, head) {
  const proxy = net.connect(API_PORT, API_HOST, () => {
    const headers = proxyHeaders(req);
    let msg = `GET ${req.url || '/'} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) msg += `${key}: ${item}\r\n`;
      } else {
        msg += `${key}: ${value}\r\n`;
      }
    }
    msg += '\r\n';
    proxy.write(msg);
    if (head && head.length) proxy.write(head);
    proxy.pipe(clientSocket);
    clientSocket.pipe(proxy);
  });
  proxy.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => proxy.destroy());
}

function safeFileFromUrl(urlPath) {
  const rel = decodeURIComponent((urlPath || '/').split('?')[0]);
  const candidate = path.resolve(DIST, '.' + (rel === '/' ? '/index.html' : rel));
  if (!candidate.startsWith(DIST)) return null;
  return candidate;
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, panelHeaders({ 'Content-Type': MIME[ext] || 'application/octet-stream' }));
  fs.createReadStream(filePath).pipe(res);
}

function sendIndexOrHelp(res) {
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) {
    sendFile(res, index);
    return;
  }
  res.writeHead(503, panelHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
  res.end('Client panel nav uzbuivets. Palaid VS.bat velreiz.\n');
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const server = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0] || '/';
    const looksApi = p === '/api' || p.startsWith('/api/') || p === '/ws' || p.startsWith('/ws/');
    if (looksApi) {
      if (!isPublicClientProxyPath(req.url)) {
        rejectProxy(
          res,
          404,
          'Not found — public panel only proxies /api/client-auth, /api/client, /ws/client\n'
        );
        return;
      }
      proxyHttp(req, res);
      return;
    }
    const file = safeFileFromUrl(req.url);
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      sendFile(res, file);
      return;
    }
    sendIndexOrHelp(res);
  });

  server.on('upgrade', (req, socket, head) => {
    if (!isPublicClientProxyPath(req.url)) {
      socket.destroy();
      return;
    }
    proxyUpgrade(req, socket, head);
  });

  server.listen(LISTEN_PORT, '0.0.0.0', () => {
    const ready = fs.existsSync(path.join(DIST, 'index.html'));
    console.log(`[vs-public] :${LISTEN_PORT} panel=${PANEL} dist=${DIST} built=${ready}`);
    console.log(`[vs-public] proxy allowlist: /health /api/client-auth/* /api/client/* /ws/client`);
  });
}
