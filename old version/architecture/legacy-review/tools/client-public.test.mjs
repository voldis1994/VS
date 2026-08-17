import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-pub-dist-'));
fs.writeFileSync(path.join(dist, 'index.html'), '<html><body>PUBLIC_OK</body></html>');

const gw = spawn(process.execPath, [path.join(dir, 'client-public.mjs')], {
  cwd: dir,
  env: {
    ...process.env,
    CLIENT_PUBLIC_PORT: '18081',
    CLIENT_DIST: dist,
    CONTROL_API_PORT: '19999',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('start timeout')), 5000);
  gw.stdout.on('data', (buf) => {
    if (String(buf).includes(':18081')) {
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
      port: 18081,
      path: '/',
      headers: { host: 'monsters-lions-korean-royal.trycloudflare.com' },
    },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, data, panel: res.headers['x-vs-panel'] }),
      );
    },
  );
  req.on('error', reject);
  req.end();
});

gw.kill('SIGTERM');
fs.rmSync(dist, { recursive: true, force: true });

if (
  body.status !== 200 ||
  !body.data.includes('PUBLIC_OK') ||
  body.data.includes('Blocked request') ||
  body.panel !== 'vs-public-18080'
) {
  console.error('FAIL', body);
  process.exit(1);
}
console.log('PASS public server ignored Vite host check for trycloudflare Host');
