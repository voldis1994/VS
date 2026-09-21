/** VS.bat health check — no cmd quoting. Exit 0 if :18080 is our panel. */
import http from 'node:http';

const port = Number(process.env.CLIENT_PUBLIC_PORT || 18080);

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path,
        headers: { host: 'panel.trycloudflare.com' },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: d, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.setTimeout(4000, () => {
      req.destroy();
      reject(new Error('TIMEOUT'));
    });
  });
}

try {
  const home = await get('/');
  if (/allowedHosts|Blocked request/i.test(home.body)) {
    console.error('VITE_FINGERPRINT');
    process.exit(9);
  }
  const p = String(home.headers['x-vs-panel'] || '');
  if (!(p.includes('vs-public') || /html/i.test(home.body) || home.status === 200 || home.status === 503)) {
    console.error('BAD_PANEL', home.status, p);
    process.exit(8);
  }

  // Audit guard: admin / pipeline must NOT be proxied to the public tunnel.
  for (const blocked of [
    '/api/robot-desk/start',
    '/api/trading/accounts',
    '/api/pipeline/intents',
    '/api/brokers',
    '/ws',
  ]) {
    const r = await get(blocked);
    if (r.status !== 404) {
      console.error('PUBLIC_PROXY_LEAK', blocked, r.status);
      process.exit(6);
    }
  }

  console.log('PANEL_OK', p || home.status);
  process.exit(0);
} catch (e) {
  console.error('DOWN', e instanceof Error ? e.message : e);
  process.exit(7);
}
