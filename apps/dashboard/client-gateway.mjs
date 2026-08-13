/**
 * Public front door for the Client Control Panel (port 5174).
 *
 * Cloudflare quick tunnels send a NEW Host every launch
 * (*.trycloudflare.com). Vite 403s those. This proxy rewrites Host to
 * 127.0.0.1:5175 so Vite always sees localhost and never blocks.
 */
import http from 'node:http';
import net from 'node:net';

const LISTEN_PORT = Number(process.env.CLIENT_PUBLIC_PORT || 5174);
const VITE_PORT = Number(process.env.CLIENT_VITE_PORT || 5175);
const VITE_HOST = '127.0.0.1';

function viteHeaders(req) {
  const headers = { ...req.headers };
  headers.host = `${VITE_HOST}:${VITE_PORT}`;
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-server'];
  return headers;
}

function proxyHttp(req, res) {
  const headers = viteHeaders(req);
  const p = http.request(
    {
      hostname: VITE_HOST,
      port: VITE_PORT,
      path: req.url,
      method: req.method,
      headers,
    },
    (incoming) => {
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(res);
    },
  );
  p.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end(`Client panel starting...\n${err.message}\n`);
  });
  req.pipe(p);
}

function proxyUpgrade(req, clientSocket, head) {
  const proxy = net.connect(VITE_PORT, VITE_HOST, () => {
    const headers = viteHeaders(req);
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

const server = http.createServer(proxyHttp);
server.on('upgrade', proxyUpgrade);
server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(
    `[client-gateway] public :${LISTEN_PORT} -> Vite ${VITE_HOST}:${VITE_PORT} (Host rewritten to localhost)`,
  );
});
