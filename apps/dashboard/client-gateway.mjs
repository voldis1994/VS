/**
 * Public Client Control Panel (port 5174).
 *
 * Serves the Vite *build* (dist-client) and proxies /api + /ws to Control API.
 * Vite is NOT in this path, so Cloudflare's changing *.trycloudflare.com
 * Host header can never trigger "Blocked request / allowedHosts".
 */
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LISTEN_PORT = Number(process.env.CLIENT_PUBLIC_PORT || 5174);
const API_HOST = process.env.CONTROL_API_HOST || '127.0.0.1';
const API_PORT = Number(process.env.CONTROL_API_PORT || 3000);
const DIST = path.resolve(process.env.CLIENT_DIST || path.join(DIR, 'dist-client'));

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

function isApiPath(url) {
  const p = (url || '/').split('?')[0];
  return p === '/api' || p.startsWith('/api/') || p === '/ws' || p.startsWith('/ws/');
}

function proxyHeaders(req) {
  const headers = { ...req.headers };
  headers.host = `${API_HOST}:${API_PORT}`;
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = 'https';
  return headers;
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
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(res);
    },
  );
  p.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
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
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function sendIndexOrHelp(res) {
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) {
    sendFile(res, index);
    return;
  }
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Client panel nav uzbuivets. Palaid VS.bat velreiz (vite build).\n');
}

const server = http.createServer((req, res) => {
  if (isApiPath(req.url)) {
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
  if (isApiPath(req.url)) {
    proxyUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  const ready = fs.existsSync(path.join(DIST, 'index.html'));
  console.log(
    `[client-gateway] public :${LISTEN_PORT}  static=${DIST}  api=${API_HOST}:${API_PORT}  built=${ready}`,
  );
});
