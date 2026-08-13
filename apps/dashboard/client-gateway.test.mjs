import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));

const viteFake = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`vite-host=${req.headers.host}\n`);
});

await new Promise((resolve) => viteFake.listen(5175, '127.0.0.1', resolve));

const gw = spawn(process.execPath, [path.join(dir, 'client-gateway.mjs')], {
  cwd: dir,
  env: { ...process.env, CLIENT_PUBLIC_PORT: '5174', CLIENT_VITE_PORT: '5175' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('gateway start timeout')), 5000);
  gw.stdout.on('data', (buf) => {
    if (String(buf).includes('public :5174')) {
      clearTimeout(t);
      resolve();
    }
  });
  gw.stderr.on('data', (buf) => process.stderr.write(buf));
});

const body = await new Promise((resolve, reject) => {
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 5174,
      path: '/',
      headers: { host: 'vape-timeline-addresses-started.trycloudflare.com' },
    },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    },
  );
  req.on('error', reject);
  req.end();
});

gw.kill('SIGTERM');
viteFake.close();

if (body.status !== 200 || !body.data.includes('vite-host=127.0.0.1:5175')) {
  console.error('FAIL', body);
  process.exit(1);
}
console.log('PASS host rewritten:', body.data.trim());
