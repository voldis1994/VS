/**
 * Live control-api runner — NO tsx watch.
 * Exit code 75 = BRAIN accepted .ts patches while FLAT → restart to load new code.
 * Mid-trade file writes must NOT kill the API (that caused Failed to fetch).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAIN_RELOAD_EXIT_CODE = 75;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const apiDir = path.join(root, 'apps', 'control-api');

function runOnce() {
  return new Promise((resolve) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCmd, ['run', 'dev:live'], {
      cwd: apiDir,
      stdio: 'inherit',
      env: { ...process.env, CONTROL_API_LIVE_LOOP: '1' },
      shell: process.platform === 'win32',
    });
    child.on('exit', (code, signal) => {
      resolve({ code: code == null ? 1 : code, signal });
    });
  });
}

console.log('[control-api-live] start (no watch) — BRAIN .ts reload via exit 75 when FLAT');

for (;;) {
  const { code, signal } = await runOnce();
  if (code === BRAIN_RELOAD_EXIT_CODE) {
    console.log('[control-api-live] BRAIN code reload — restarting API…');
    continue;
  }
  if (signal) {
    console.log(`[control-api-live] killed by ${signal}`);
    process.exit(1);
  }
  console.log(`[control-api-live] exit ${code}`);
  process.exit(code);
}
