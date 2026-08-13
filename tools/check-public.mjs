/** VS.bat health check — no cmd quoting. Exit 0 if :18080 is our panel. */
import http from 'node:http';

const port = Number(process.env.CLIENT_PUBLIC_PORT || 18080);
const req = http.get(
  {
    hostname: '127.0.0.1',
    port,
    path: '/',
    headers: { host: 'panel.trycloudflare.com' },
  },
  (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => {
      if (/allowedHosts|Blocked request/i.test(d)) {
        console.error('VITE_FINGERPRINT');
        process.exit(9);
      }
      const p = String(res.headers['x-vs-panel'] || '');
      if (p.includes('vs-public') || /html/i.test(d) || res.statusCode === 200 || res.statusCode === 503) {
        console.log('PANEL_OK', p || res.statusCode);
        process.exit(0);
      }
      console.error('BAD_PANEL', res.statusCode, p);
      process.exit(8);
    });
  },
);
req.on('error', (e) => {
  console.error('DOWN', e.message);
  process.exit(7);
});
req.setTimeout(4000, () => {
  req.destroy();
  console.error('TIMEOUT');
  process.exit(7);
});
