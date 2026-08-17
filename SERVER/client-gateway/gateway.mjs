#!/usr/bin/env node
/**
 * VS CLIENT HTTPS gateway — public door to ONE core.
 * Listens :443 (TLS when certs exist). Proxies only CLIENT routes to Control API.
 * Never forwards ADMIN / system / monitor / lan-bootstrap.
 *
 * Stable URL is VS_PUBLIC_CLIENT_URL in /etc/vs/client-url (not git).
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CLIENT_PATH_ALLOW = [
  /^\/api\/client-auth(\/|$)/,
  /^\/api\/client(\/|$)/,
  /^\/ws\/client(\/|$)/,
  /^\/health$/,
];

export const CLIENT_PATH_DENY = [
  /^\/api\/v1\/admin(\/|$)/,
  /^\/api\/clients(\/|$)/,
  /^\/api\/system(\/|$)/,
  /^\/api\/v1\/server(\/|$)/,
  /^\/api\/v1\/network(\/|$)/,
  /^\/api\/pipeline(\/|$)/,
  /^\/api\/brokers(\/|$)/,
  /^\/api\/robot/,
  /^\/ws$/,
];

export function isClientPublicPath(urlPath) {
  const p = (urlPath || '/').split('?')[0];
  if (CLIENT_PATH_DENY.some((re) => re.test(p))) return false;
  if (CLIENT_PATH_ALLOW.some((re) => re.test(p))) return true;
  if (p.startsWith('/api') || p.startsWith('/ws')) return false;
  return true; // static SPA
}

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function loadStableUrl() {
  const file = env('VS_CLIENT_URL_FILE', '/etc/vs/client-url');
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const line = raw
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));
      if (line) return line.replace(/\/$/, '');
    }
  } catch {
    /* ignore */
  }
  return env('VS_PUBLIC_CLIENT_URL') || env('VS_PUBLIC_HOST');
}

function tlsOptions() {
  const cert = env('VS_CLIENT_TLS_CERT', '/etc/vs/tls/fullchain.pem');
  const key = env('VS_CLIENT_TLS_KEY', '/etc/vs/tls/privkey.pem');
  if (fs.existsSync(cert) && fs.existsSync(key)) {
    return {
      cert: fs.readFileSync(cert),
      key: fs.readFileSync(key),
    };
  }
  return null;
}

const UPSTREAM_HOST = env('VS_CONTROL_API_HOST', '127.0.0.1');
const UPSTREAM_PORT = Number(env('CONTROL_API_PORT') || env('VS_CONTROL_API_PORT') || 3000);
const LISTEN_HOST = env('VS_CLIENT_GATEWAY_HOST', '0.0.0.0');
const HTTPS_PORT = Number(env('VS_CLIENT_GATEWAY_PORT') || 443);
const HTTP_PORT = Number(env('VS_CLIENT_GATEWAY_HTTP_PORT') || 80);

function proxy(req, res) {
  const urlPath = req.url || '/';
  if (!isClientPublicPath(urlPath)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'CLIENT_FORBIDDEN_ADMIN', message: 'Admin API is not public' }));
    return;
  }

  const headers = { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` };
  delete headers['connection'];

  const p = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: urlPath,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  p.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'GATEWAY_UPSTREAM', message: err.message }));
  });
  req.pipe(p);
}

function onUpgrade(req, socket, head) {
  const urlPath = req.url || '/';
  if (!isClientPublicPath(urlPath)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const up = createConnection({ host: UPSTREAM_HOST, port: UPSTREAM_PORT }, () => {
    const hdrs = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n');
    up.write(`${req.method} ${urlPath} HTTP/${req.httpVersion}\r\n${hdrs}\r\n\r\n`);
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
}

export function createGatewayServer() {
  const tls = tlsOptions();
  const handler = (req, res) => proxy(req, res);
  if (tls) {
    const s = https.createServer(tls, handler);
    s.on('upgrade', onUpgrade);
    return { server: s, tls: true, port: HTTPS_PORT };
  }
  const allowHttp = env('VS_CLIENT_ALLOW_HTTP', '1') === '1';
  if (!allowHttp) {
    throw new Error('No TLS certs at /etc/vs/tls and VS_CLIENT_ALLOW_HTTP is not 1');
  }
  const s = http.createServer(handler);
  s.on('upgrade', onUpgrade);
  return { server: s, tls: false, port: Number(env('VS_CLIENT_GATEWAY_PLAIN_PORT') || HTTPS_PORT) };
}

function main() {
  const stable = loadStableUrl();
  const { server, tls, port } = createGatewayServer();
  server.listen(port, LISTEN_HOST, () => {
    const mode = tls ? 'HTTPS' : 'HTTP (set /etc/vs/tls for production TLS)';
    process.stdout.write(
      `VS CLIENT GATEWAY ${mode} ${LISTEN_HOST}:${port} → ${UPSTREAM_HOST}:${UPSTREAM_PORT}\n`
    );
    process.stdout.write(`STABLE_URL=${stable || '(set /etc/vs/client-url)'}\n`);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
