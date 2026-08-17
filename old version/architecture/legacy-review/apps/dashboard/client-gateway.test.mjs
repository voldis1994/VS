import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-client-dist-'));
fs.writeFileSync(path.join(dist, 'index.html'), '<html><body>CLIENT_OK</body></html>');

const gw = spawn(process.execPath, [path.join(dir, 'client-gateway.mjs')], {
  cwd: dir,
  env: {
    ...process.env,
    CLIENT_PUBLIC_PORT: '15174',
    CLIENT_DIST: dist,
    CONTROL_API_PORT: '19999',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('gateway start timeout')), 5000);
  gw.stdout.on('data', (buf) => {
    if (String(buf).includes('public :15174')) {
      clearTimeout(t);
      resolve();
    }
  });
  gw.stderr.on('data', (buf) => process.stderr.write(buf));
});

function get(host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 15174,
        path: '/',
        headers: { host },
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
}

const blockedHost = 'analytical-lightweight-remarkable-cat.trycloudflare.com';
const body = await get(blockedHost);
gw.kill('SIGTERM');
fs.rmSync(dist, { recursive: true, force: true });

if (body.status !== 200 || !body.data.includes('CLIENT_OK') || body.data.includes('Blocked request')) {
  console.error('FAIL', body);
  process.exit(1);
}
console.log('PASS tunnel host served static panel:', blockedHost);
