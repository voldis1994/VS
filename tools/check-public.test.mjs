import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

function runCheck(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'check-public.mjs')], {
      env: { ...process.env, CLIENT_PUBLIC_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

function listen(port, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const down = await runCheck(18083);
if (down.code !== 7) {
  console.error('FAIL expected DOWN=7', down);
  process.exit(1);
}

const vite = await listen(18084, (_req, res) => {
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end('Blocked request. This host is not allowed.\n');
});
const viteCheck = await runCheck(18084);
vite.close();
if (viteCheck.code !== 9 || !viteCheck.out.includes('VITE_FINGERPRINT')) {
  console.error('FAIL expected VITE=9', viteCheck);
  process.exit(1);
}

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-check-dist-'));
fs.writeFileSync(path.join(dist, 'index.html'), '<html><body>PUBLIC_OK</body></html>');
const gw = spawn(process.execPath, [path.join(dir, 'client-public.mjs')], {
  cwd: dir,
  env: {
    ...process.env,
    CLIENT_PUBLIC_PORT: '18085',
    CLIENT_DIST: dist,
    CONTROL_API_PORT: '19999',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('start timeout')), 5000);
  gw.stdout.on('data', (buf) => {
    if (String(buf).includes(':18085')) {
      clearTimeout(t);
      resolve();
    }
  });
  gw.stderr.on('data', (buf) => process.stderr.write(buf));
});
const ok = await runCheck(18085);
gw.kill('SIGTERM');
fs.rmSync(dist, { recursive: true, force: true });
if (ok.code !== 0 || !ok.out.includes('PANEL_OK')) {
  console.error('FAIL expected PANEL_OK', ok);
  process.exit(1);
}
console.log('PASS check-public down/vite/panel');
